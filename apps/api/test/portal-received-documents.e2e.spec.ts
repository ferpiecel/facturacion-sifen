import { createHash, randomUUID } from 'node:crypto';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { createPgliteDatabase, type DatabaseHandle } from '@sifen/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { createHttpAdapter } from '../src/bootstrap/http.js';
import { createTenant } from '../src/cli/commands.js';
import { DATABASE, DATABASE_HANDLE } from '../src/modules/database/database.module.js';
import { createReceivedDocument } from '../src/modules/reception/domain/received-document.js';
import { createDrizzleReceivedDocumentRepository } from '../src/modules/reception/infrastructure/adapters/drizzle-received-document-repository.js';
import { InMemoryStorageProvider } from '../src/modules/reception/infrastructure/adapters/in-memory-storage-provider.js';
import { RECEPTION_STORAGE } from '../src/modules/reception/reception.tokens.js';
import { portalSessionCookie } from './support/portal-session.js';

interface Item {
  id: string;
  is_own_receiver: boolean;
}

/** Spec: reception R7.1. The portal only reads received documents; writes stay API-key only. */
describe('GET /portal/received-documents (e2e)', () => {
  let handle: DatabaseHandle;
  let app: NestFastifyApplication;
  let cookie: string;
  const ids: Record<'own' | 'foreignReceiver' | 'otherTenant' | 'otherTenantArtifact', string> = {
    own: '',
    foreignReceiver: '',
    otherTenant: '',
    otherTenantArtifact: '',
  };
  const XML = Buffer.from('<?xml version="1.0"?><rDE><DE Id="x"/></rDE>');
  const HOSTILE_XML = Buffer.from(
    '<?xml version="1.0"?><?xml-stylesheet type="text/xsl" href="//evil/x.xsl"?>' +
      '<html xmlns="http://www.w3.org/1999/xhtml"><script>fetch("/api/auth/me")</script></html>',
  );
  let withArtifact = '';
  let hostileXml = '';
  let pdf = '';
  let png = '';
  const storage = new InMemoryStorageProvider();
  const originalEnvironment = process.env.SIFEN_ENVIRONMENT;

  const call = (method: string, url: string, withCookie: string | undefined = cookie) =>
    app.inject({
      method: method as 'GET',
      url,
      headers: withCookie ? { cookie: withCookie } : {},
    });

  const seed = async (
    tenantId: string,
    isOwnReceiver: boolean,
    withBytes = false,
    stored: { bytes: Buffer; contentType: string; name: string } = {
      bytes: XML,
      contentType: 'application/xml',
      name: 'fac"tura.xml',
    },
  ): Promise<string> => {
    const id = randomUUID();
    const storageKey = `sifen_xml/${tenantId}/${id}.xml`;
    if (withBytes) await storage.upload(storageKey, stored.bytes);
    await createDrizzleReceivedDocumentRepository(handle.db).create(tenantId, {
      document: createReceivedDocument({ id, tenantId, source: 'sifen_xml', isOwnReceiver }),
      artifact: withBytes
        ? {
            storageKey,
            contentType: stored.contentType,
            sha256: createHash('sha256').update(stored.bytes).update(id).digest('hex'),
            sizeBytes: stored.bytes.byteLength,
            originalName: stored.name,
            pageCount: null,
          }
        : undefined,
    });
    return id;
  };

  beforeAll(async () => {
    process.env.SIFEN_ENVIRONMENT = 'production';
    handle = createPgliteDatabase();
    await handle.migrate();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE_HANDLE)
      .useValue(handle)
      .overrideProvider(DATABASE)
      .useValue(handle.db)
      .overrideProvider(RECEPTION_STORAGE)
      .useValue(storage)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const acme = (await createTenant(handle.db, 'Acme SA')).id;
    const globex = (await createTenant(handle.db, 'Globex SA')).id;
    ids.own = await seed(acme, true);
    ids.foreignReceiver = await seed(acme, false);
    ids.otherTenant = await seed(globex, true);
    ids.otherTenantArtifact = await seed(globex, true, true);
    withArtifact = await seed(acme, true, true);
    hostileXml = await seed(acme, true, true, {
      bytes: HOSTILE_XML,
      contentType: 'application/xml',
      name: 'x.xml',
    });
    pdf = await seed(acme, true, true, {
      bytes: Buffer.from('%PDF-1.4'),
      contentType: 'application/pdf',
      name: 'a.pdf',
    });
    png = await seed(acme, true, true, {
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      contentType: 'image/png',
      name: 'a.png',
    });
    cookie = await portalSessionCookie(handle.db, 'lector@example.com', {
      tenantId: acme,
      role: 'lector',
    });
  });

  afterAll(async () => {
    await app.close();
    if (originalEnvironment === undefined) delete process.env.SIFEN_ENVIRONMENT;
    else process.env.SIFEN_ENVIRONMENT = originalEnvironment;
  });

  it('lists only the session tenant documents and flags the ones for another receiver', async () => {
    const res = await call('GET', '/portal/received-documents');

    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const items = res.json<{ items: Item[]; next_cursor: string | null }>().items;
    expect(items.map((item) => item.id).sort()).toEqual(
      [ids.own, ids.foreignReceiver, withArtifact, hostileXml, pdf, png].sort(),
    );
    expect(items.find((item) => item.id === ids.foreignReceiver)?.is_own_receiver).toBe(false);
    expect(items.find((item) => item.id === ids.own)?.is_own_receiver).toBe(true);
  });

  it('answers 400 for a malformed filter', async () => {
    expect((await call('GET', '/portal/received-documents?limit=abc')).statusCode).toBe(400);
  });

  it('returns the detail of a document of the session tenant', async () => {
    const res = await call('GET', `/portal/received-documents/${ids.foreignReceiver}`);

    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.json<Item>()).toMatchObject({ id: ids.foreignReceiver, is_own_receiver: false });
  });

  it('answers 404 for another tenant and an unknown id, 400 for a malformed one', async () => {
    for (const id of [ids.otherTenant, randomUUID()]) {
      expect((await call('GET', `/portal/received-documents/${id}`)).statusCode, id).toBe(404);
    }
  });

  it('answers 400 for a malformed id', async () => {
    expect((await call('GET', '/portal/received-documents/not-a-uuid')).statusCode).toBe(400);
  });

  it('answers 401 without a session', async () => {
    for (const url of ['/portal/received-documents', `/portal/received-documents/${ids.own}`]) {
      expect((await call('GET', url, '')).statusCode, url).toBe(401);
    }
  });

  it('points the detail artifact_url at the portal route, not at /v1', async () => {
    const res = await call('GET', `/portal/received-documents/${withArtifact}`);

    expect(res.json<{ artifact_url: string }>().artifact_url).toBe(
      `/portal/received-documents/${withArtifact}/artifact`,
    );
    const bare = await call('GET', `/portal/received-documents/${ids.own}`);
    expect(bare.json<{ artifact_url: string | null }>().artifact_url).toBeNull();
  });

  it('streams the stored bytes of a session tenant document with hardened headers', async () => {
    const res = await call('GET', `/portal/received-documents/${withArtifact}/artifact`);

    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toContain('application/xml');
    expect(res.headers['content-disposition']).toBe('attachment; filename="fac_tura.xml"');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.rawPayload.equals(XML)).toBe(true);
  });

  it('serves XML (even hostile XHTML) as an attachment, never rendered in the portal origin', async () => {
    const res = await call('GET', `/portal/received-documents/${hostileXml}/artifact`);

    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="x.xml"');
    expect(res.rawPayload.equals(HOSTILE_XML)).toBe(true);
  });

  it('keeps PDFs and images inline', async () => {
    const a = await call('GET', `/portal/received-documents/${pdf}/artifact`);
    const b = await call('GET', `/portal/received-documents/${png}/artifact`);

    expect(a.headers['content-disposition']).toBe('inline; filename="a.pdf"');
    expect(b.headers['content-disposition']).toBe('inline; filename="a.png"');
  });

  it('sends a restrictive CSP with the artifact', async () => {
    const res = await call('GET', `/portal/received-documents/${pdf}/artifact`);

    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
  });

  it('no longer exposes artifact-url in the portal', async () => {
    const res = await call('GET', `/portal/received-documents/${withArtifact}/artifact-url`);

    expect(res.statusCode).toBe(404);
  });

  it('answers 404 for the artifact of another tenant, an unknown id or a document without one', async () => {
    for (const id of [ids.otherTenantArtifact, randomUUID(), ids.own]) {
      const res = await call('GET', `/portal/received-documents/${id}/artifact`);
      expect(res.statusCode, id).toBe(404);
      expect(res.json()).toMatchObject({ code: 'not_found' });
    }
  });

  it('answers 400 for a malformed artifact id and 401 without a session', async () => {
    expect((await call('GET', '/portal/received-documents/nope/artifact')).statusCode).toBe(400);
    const url = `/portal/received-documents/${withArtifact}/artifact`;
    expect((await call('GET', url, '')).statusCode, url).toBe(401);
  });

  it('does not expose write routes', async () => {
    const attempts: [string, string][] = [
      ['POST', '/portal/received-documents'],
      ['PATCH', `/portal/received-documents/${ids.own}`],
      ['DELETE', `/portal/received-documents/${ids.own}`],
      ['POST', `/portal/received-documents/${ids.own}/reprocess`],
      ['POST', `/portal/received-documents/${withArtifact}/artifact`],
      ['PUT', `/portal/received-documents/${withArtifact}/artifact`],
      ['DELETE', `/portal/received-documents/${withArtifact}/artifact`],
    ];
    for (const [method, url] of attempts) {
      expect((await call(method, url)).statusCode, `${method} ${url}`).toBe(404);
    }
  });
});
