import { randomUUID } from 'node:crypto';
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
  const ids: Record<'own' | 'foreignReceiver' | 'otherTenant', string> = {
    own: '',
    foreignReceiver: '',
    otherTenant: '',
  };
  const originalEnvironment = process.env.SIFEN_ENVIRONMENT;

  const call = (method: string, url: string, withCookie: string | undefined = cookie) =>
    app.inject({
      method: method as 'GET',
      url,
      headers: withCookie ? { cookie: withCookie } : {},
    });

  const seed = async (tenantId: string, isOwnReceiver: boolean): Promise<string> => {
    const id = randomUUID();
    await createDrizzleReceivedDocumentRepository(handle.db).create(tenantId, {
      document: createReceivedDocument({ id, tenantId, source: 'sifen_xml', isOwnReceiver }),
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
      .useValue(null)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const acme = (await createTenant(handle.db, 'Acme SA')).id;
    const globex = (await createTenant(handle.db, 'Globex SA')).id;
    ids.own = await seed(acme, true);
    ids.foreignReceiver = await seed(acme, false);
    ids.otherTenant = await seed(globex, true);
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
    expect(items.map((item) => item.id).sort()).toEqual([ids.own, ids.foreignReceiver].sort());
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

  it('does not expose write routes', async () => {
    const attempts: [string, string][] = [
      ['POST', '/portal/received-documents'],
      ['PATCH', `/portal/received-documents/${ids.own}`],
      ['DELETE', `/portal/received-documents/${ids.own}`],
      ['POST', `/portal/received-documents/${ids.own}/reprocess`],
    ];
    for (const [method, url] of attempts) {
      expect((await call(method, url)).statusCode, `${method} ${url}`).toBe(404);
    }
  });
});
