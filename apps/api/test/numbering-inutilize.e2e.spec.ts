import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { createPgliteDatabase, issuerEvents, type DatabaseHandle } from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTenant, issueApiKey } from '../src/cli/commands.js';
import { createHttpAdapter } from '../src/bootstrap/http.js';
import { AppModule } from '../src/app.module.js';
import { DATABASE, DATABASE_HANDLE } from '../src/modules/database/database.module.js';
import { acceptInvoiceWithStatus, seedIssuer } from './support/credit-note-fixture.js';

const BODY = {
  timbrado: '22222222',
  establishment: '001',
  expeditionPoint: '002',
  type: 1,
  from: 2,
  to: 2,
  reason: 'Numero rechazado y no se reutiliza',
};

/** Spec: HU-E8-03. `POST /v1/numbering/inutilize` through the real pipeline. */
describe('POST /v1/numbering/inutilize (e2e)', () => {
  let handle: DatabaseHandle;
  let app: NestFastifyApplication;
  const originalEnvironment = process.env.SIFEN_ENVIRONMENT;
  let writer: string;
  let reader: string;

  async function seedTenant(name: string, scopes: string[]) {
    const { id } = await createTenant(handle.db, name);
    const { formattedKey } = await issueApiKey(handle.db, {
      tenantId: id,
      environment: 'live',
      scopes,
    });
    await seedIssuer(handle.db, id);
    return { id, key: formattedKey };
  }

  const inutilize = (key: string, body: unknown, idempotencyKey?: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/numbering/inutilize',
      payload: body as object,
      headers: {
        authorization: `Bearer ${key}`,
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
    });

  beforeEach(async () => {
    process.env.SIFEN_ENVIRONMENT = 'production';
    handle = createPgliteDatabase();
    await handle.migrate();
    const tenant = await seedTenant('Acme SA', ['documents:write']);
    writer = tenant.key;
    reader = (await seedTenant('Reader SA', ['documents:read'])).key;
    // Numbers 1 (approved), 2 (rejected) and 3 (approved) are issued.
    for (const [i, status] of ['approved', 'rejected', 'approved'].entries()) {
      await acceptInvoiceWithStatus(handle.db, tenant.id, `fe-${String(i)}`, status);
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE_HANDLE)
      .useValue(handle)
      .overrideProvider(DATABASE)
      .useValue(handle.db)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
    if (originalEnvironment === undefined) delete process.env.SIFEN_ENVIRONMENT;
    else process.env.SIFEN_ENVIRONMENT = originalEnvironment;
  });

  it('answers 202 and stores a pending voiding with its range', async () => {
    const response = await inutilize(writer, BODY, 'k-1');

    expect(response.statusCode).toBe(202);
    const { event_id: id, status } = response.json<{ event_id: string; status: string }>();
    expect(status).toBe('pending');
    const [row] = await handle.db.select().from(issuerEvents);
    expect(row).toMatchObject({ id, kind: 'voiding', status: 'pending', documentId: null });
    expect(row.voidRange).toMatchObject({ from: 2, to: 2, point: '002' });
  });

  it('returns the same response for the same key and body, and 409 for another body', async () => {
    const first = await inutilize(writer, BODY, 'k-1');
    const again = await inutilize(writer, BODY, 'k-1');
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual(first.json());
    expect(
      (await inutilize(writer, { ...BODY, reason: 'Otro motivo distinto' }, 'k-1')).statusCode,
    ).toBe(409);
    expect(await handle.db.select().from(issuerEvents)).toHaveLength(1);
  });

  it('answers 422 with the rule and SIFEN code when the range holds a document (4065)', async () => {
    const response = await inutilize(writer, { ...BODY, from: 1, to: 3 }, 'k-1');
    expect(response.statusCode).toBe(422);
    expect(response.json<{ errors: Record<string, unknown>[] }>().errors[0]).toMatchObject({
      rule: 'range-has-documents',
      sifenCode: '4065',
      numbers: [1, 3],
    });
    expect(await handle.db.select().from(issuerEvents)).toHaveLength(0);
  });

  it('answers 422 for a range of more than 1000 numbers (4067) and for a bad reason', async () => {
    const big = await inutilize(writer, { ...BODY, from: 1, to: 1001 }, 'k-1');
    expect(big.json<{ errors: { rule: string; sifenCode: string }[] }>().errors[0]).toMatchObject({
      rule: 'range-too-large',
      sifenCode: '4067',
    });
    const bad = await inutilize(writer, { ...BODY, reason: 'no' }, 'k-2');
    expect(bad.statusCode).toBe(422);
    expect(bad.json<{ errors: { field: string }[] }>().errors[0].field).toBe('reason');
  });

  it('answers 400 without an Idempotency-Key and 403 for a read-only key', async () => {
    expect((await inutilize(writer, BODY)).statusCode).toBe(400);
    expect((await inutilize(reader, BODY, 'k-3')).statusCode).toBe(403);
  });
});
