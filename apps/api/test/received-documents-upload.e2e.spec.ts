import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { createPgliteDatabase, tenantFiscalProfiles, type DatabaseHandle } from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { createHttpAdapter } from '../src/bootstrap/http.js';
import { createTenant, issueApiKey } from '../src/cli/commands.js';
import { DATABASE, DATABASE_HANDLE } from '../src/modules/database/database.module.js';
import { InMemoryStorageProvider } from '../src/modules/reception/infrastructure/adapters/in-memory-storage-provider.js';
import { RECEPTION_STORAGE } from '../src/modules/reception/reception.tokens.js';

const GOLDEN = readFileSync(
  fileURLToPath(
    new URL('./fixtures/reception/sifen/factura_contado/documento.xml', import.meta.url),
  ),
);
const MAX_BYTES = 2 * 1024 * 1024;

interface Body {
  id?: string;
  status?: string;
  version?: number;
  source?: string;
  code?: string;
  message?: string;
  document_id?: string;
}

/** Spec: reception R4.2. `POST /v1/received-documents` for SIFEN XML (asynchronous contract, Q6). */
describe('POST /v1/received-documents (e2e)', () => {
  let handle: DatabaseHandle;
  let app: NestFastifyApplication;
  let storage: InMemoryStorageProvider;
  let tenantA: string;
  let tenantB: string;
  let keyA: string;
  let keyB: string;
  const originalEnvironment = process.env.SIFEN_ENVIRONMENT;

  const boot = async (provider: InMemoryStorageProvider | null) => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE_HANDLE)
      .useValue(handle)
      .overrideProvider(DATABASE)
      .useValue(handle.db)
      .overrideProvider(RECEPTION_STORAGE)
      .useValue(provider)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  };

  const post = (key: string, contentType: string | null, payload: Buffer | string) =>
    app.inject({
      method: 'POST',
      url: '/v1/received-documents',
      headers: {
        authorization: `Bearer ${key}`,
        ...(contentType === null ? {} : { 'content-type': contentType }),
      },
      payload,
    });

  const multipart = (bytes: Buffer, filename = 'factura.xml') => {
    const boundary = '----reception-e2e';
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/xml\r\n\r\n`;
    return {
      contentType: `multipart/form-data; boundary=${boundary}`,
      payload: Buffer.concat([Buffer.from(head), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    };
  };

  beforeEach(async () => {
    process.env.SIFEN_ENVIRONMENT = 'production';
    handle = createPgliteDatabase();
    await handle.migrate();
    tenantA = (await createTenant(handle.db, 'Acme SA')).id;
    tenantB = (await createTenant(handle.db, 'Beta SA')).id;
    const scopes = ['reception:write'];
    keyA = (await issueApiKey(handle.db, { tenantId: tenantA, environment: 'live', scopes }))
      .formattedKey;
    keyB = (await issueApiKey(handle.db, { tenantId: tenantB, environment: 'live', scopes }))
      .formattedKey;
    // The golden receiver is 80000001-8; its CDC and issuer DV are anonymized, so it needs review.
    for (const tenantId of [tenantA, tenantB]) {
      await handle.db.insert(tenantFiscalProfiles).values({
        tenantId,
        rucBase: '80000001',
        rucDv: 8,
        legalName: 'Empresa SA',
        taxpayerType: 'persona_juridica',
      });
    }
    storage = new InMemoryStorageProvider();
    await boot(expect.getState().currentTestName?.includes('is disabled') ? null : storage);
  });

  afterEach(async () => {
    await app.close();
    if (originalEnvironment === undefined) delete process.env.SIFEN_ENVIRONMENT;
    else process.env.SIFEN_ENVIRONMENT = originalEnvironment;
  });

  it('accepts a raw application/xml body with 202, Location and a minimal body', async () => {
    const response = await post(keyA, 'application/xml', GOLDEN);
    const body = response.json<Body>();

    expect(response.statusCode).toBe(202);
    expect(response.headers.location).toBe(`/v1/received-documents/${body.id ?? ''}`);
    expect(Object.keys(body).sort()).toEqual(['id', 'source', 'status', 'version']);
    expect(body).toMatchObject({ status: 'needs_review', version: 1, source: 'sifen_xml' });
  });

  it('accepts text/xml and a multipart file, deduping by content with 200', async () => {
    const first = (await post(keyA, 'text/xml; charset=utf-8', GOLDEN)).json<Body>();
    const form = multipart(GOLDEN);
    const again = await post(keyA, form.contentType, form.payload);

    expect(again.statusCode).toBe(200);
    expect(again.headers.location).toBe(`/v1/received-documents/${first.id ?? ''}`);
    expect(again.json<Body>()).toEqual(first);
  });

  it('accepts JSON { xml } and dedupes by CDC when the bytes differ', async () => {
    const first = (await post(keyA, 'application/xml', GOLDEN)).json<Body>();
    const resigned = JSON.stringify({ xml: `${GOLDEN.toString('utf8')}\n<!-- re-signed -->` });
    const again = await post(keyA, 'application/json', resigned);

    expect(again.statusCode).toBe(200);
    expect(again.json<Body>().id).toBe(first.id);
  });

  it('keeps tenants apart: tenant B neither dedupes against nor sees tenant A', async () => {
    const a = (await post(keyA, 'application/xml', GOLDEN)).json<Body>();
    const b = await post(keyB, 'application/xml', GOLDEN);

    expect(b.statusCode).toBe(202);
    expect(b.json<Body>().id).not.toBe(a.id);
  });

  it('answers 413 payload_too_large above the configured cap', async () => {
    const huge = Buffer.concat([Buffer.from('<a>'), Buffer.alloc(MAX_BYTES, 0x20)]);
    const raw = await post(keyA, 'application/xml', huge);
    const form = multipart(huge);
    const file = await post(keyA, form.contentType, form.payload);

    expect(raw.statusCode).toBe(413);
    expect(raw.json<Body>().code).toBe('payload_too_large');
    expect(file.statusCode).toBe(413);
    expect(file.json<Body>().code).toBe('payload_too_large');
  });

  it('answers 415 unsupported_media_type when the bytes do not look like XML', async () => {
    const response = await post(keyA, 'application/octet-stream', Buffer.from('plain text'));

    expect(response.statusCode).toBe(415);
    expect(response.json<Body>().code).toBe('unsupported_media_type');
    expect((await post(keyA, 'text/plain', 'x')).statusCode).toBe(415);
  });

  it('answers 422 unsupported_source for PDF, images and CDC-only requests', async () => {
    const pdf = await post(keyA, 'application/pdf', Buffer.from('%PDF-1.7\n'));
    const png = await post(
      keyA,
      'application/octet-stream',
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const cdc = await post(keyA, 'application/json', JSON.stringify({ cdc: '1'.repeat(44) }));

    for (const response of [pdf, png, cdc]) {
      expect(response.statusCode).toBe(422);
      expect(response.json<Body>().code).toBe('unsupported_source');
    }
  });

  it('answers 422 extraction_failed with the stored document id for malformed XML', async () => {
    const response = await post(keyA, 'application/xml', Buffer.from('<a><b></a>'));
    const body = response.json<Body>();

    expect(response.statusCode).toBe(422);
    expect(body.code).toBe('extraction_failed');
    expect(body.document_id).toMatch(/^[0-9a-f-]{36}$/);
    const again = await post(keyA, 'application/xml', Buffer.from('<a><b></a>'));
    expect(again.statusCode).toBe(422);
    expect(again.json<Body>().document_id).toBe(body.document_id);
  });

  it('answers 422 empty_upload for an empty body and invalid_request for a bad JSON shape', async () => {
    const empty = await post(keyA, 'application/xml', Buffer.alloc(0));
    const shape = await post(keyA, 'application/json', JSON.stringify({ xml: 5 }));

    expect(empty.statusCode).toBe(422);
    expect(empty.json<Body>().code).toBe('empty_upload');
    expect(shape.statusCode).toBe(422);
    expect(shape.json<Body>().code).toBe('invalid_request');
  });

  it('answers 503 storage_unavailable without leaking settings when storage is disabled', async () => {
    const response = await post(keyA, 'application/xml', GOLDEN);

    expect(response.statusCode).toBe(503);
    expect(response.json<Body>().code).toBe('storage_unavailable');
    expect(response.body).not.toMatch(/bucket|endpoint|http/i);
  });
});
