import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { createPgliteDatabase, issuerEvents, type DatabaseHandle } from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTenant, issueApiKey } from '../src/cli/commands.js';
import { createHttpAdapter } from '../src/bootstrap/http.js';
import { AppModule } from '../src/app.module.js';
import { DATABASE, DATABASE_HANDLE } from '../src/modules/database/database.module.js';
import { acceptInvoiceWithStatus, seedIssuer } from './support/credit-note-fixture.js';

/** Spec: HU-E8-02. `POST /v1/documents/{id}/cancel` through the real pipeline. */
describe('POST /v1/documents/{id}/cancel (e2e)', () => {
  let handle: DatabaseHandle;
  let app: NestFastifyApplication;
  const originalEnvironment = process.env.SIFEN_ENVIRONMENT;

  const tenantIds = new Map<string, string>();
  async function seedTenant(name: string, scopes: string[]) {
    const { id } = await createTenant(handle.db, name);
    const { formattedKey } = await issueApiKey(handle.db, {
      tenantId: id,
      environment: 'live',
      scopes,
    });
    await seedIssuer(handle.db, id);
    tenantIds.set(formattedKey, id);
    return formattedKey;
  }

  let sequence = 0;
  const auth = (key: string) => ({ authorization: `Bearer ${key}` });
  /** An FE of the key's tenant, approved by SIFEN unless `status` says otherwise. */
  const create = async (key: string, status = 'approved') => ({
    document_id: (
      await acceptInvoiceWithStatus(
        handle.db,
        tenantIds.get(key) ?? '',
        `c-${String(++sequence)}`,
        status,
      )
    ).documentId,
  });
  const cancel = (id: string, key: string, body: unknown, idempotencyKey?: string) =>
    app.inject({
      method: 'POST',
      url: `/v1/documents/${id}/cancel`,
      payload: body as object,
      headers: {
        ...auth(key),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
    });

  let writer: string;
  let reader: string;
  let other: string;

  beforeEach(async () => {
    process.env.SIFEN_ENVIRONMENT = 'production';
    handle = createPgliteDatabase();
    await handle.migrate();
    writer = await seedTenant('Acme SA', ['documents:write', 'documents:read']);
    reader = await seedTenant('Reader SA', ['documents:read']);
    other = await seedTenant('Other SA', ['documents:write']);
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

  it('answers 202 and stores a pending cancellation of an approved FE', async () => {
    const { document_id: id } = await create(writer);

    const response = await cancel(id, writer, { reason: 'Error en el importe' }, 'k-1');

    expect(response.statusCode).toBe(202);
    const body = response.json<{ event_id: string; document_id: string; status: string }>();
    expect(body).toMatchObject({ document_id: id, status: 'pending' });
    const rows = await handle.db.select().from(issuerEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: body.event_id, kind: 'cancellation', status: 'pending' });
  });

  it('returns the same response for the same key and body, and 409 for another body', async () => {
    const { document_id: id } = await create(writer);
    const first = await cancel(id, writer, { reason: 'Error en el importe' }, 'k-1');
    const again = await cancel(id, writer, { reason: 'Error en el importe' }, 'k-1');
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual(first.json());
    expect((await cancel(id, writer, { reason: 'Otro motivo distinto' }, 'k-1')).statusCode).toBe(
      409,
    );
    expect(await handle.db.select().from(issuerEvents)).toHaveLength(1);
  });

  it('answers 409 when the document already has a cancellation', async () => {
    const { document_id: id } = await create(writer);
    await cancel(id, writer, { reason: 'Error en el importe' }, 'k-1');
    const second = await cancel(id, writer, { reason: 'Error en el importe' }, 'k-2');
    expect(second.statusCode).toBe(409);
    expect(second.json<{ errors: { rule: string }[] }>().errors[0].rule).toBe(
      'cancellation-already-requested',
    );
  });

  it('answers 422 with the rule for a document SIFEN has not approved', async () => {
    const { document_id: id } = await create(writer, 'signed');
    const response = await cancel(id, writer, { reason: 'Error en el importe' }, 'k-1');
    expect(response.statusCode).toBe(422);
    expect(
      response.json<{ errors: { rule: string; sifenCode: string }[] }>().errors[0],
    ).toMatchObject({ rule: 'document-not-approved', sifenCode: '4002' });
    expect(await handle.db.select().from(issuerEvents)).toHaveLength(0);
  });

  it('answers 422 for a reason that is missing or out of range', async () => {
    const { document_id: id } = await create(writer);
    for (const body of [{}, { reason: 'no' }, { reason: 'x'.repeat(501) }]) {
      const response = await cancel(id, writer, body, `k-${String(++sequence)}`);
      expect(response.statusCode).toBe(422);
      expect(response.json<{ errors: { field: string }[] }>().errors[0].field).toBe('reason');
    }
  });

  it('answers 400 without an Idempotency-Key or with a malformed id', async () => {
    const { document_id: id } = await create(writer);
    expect((await cancel(id, writer, { reason: 'Error en el importe' })).statusCode).toBe(400);
    expect((await cancel('nope', writer, { reason: 'Error en el importe' }, 'k')).statusCode).toBe(
      400,
    );
  });

  it("answers 404 for another tenant's document and 403 for a read-only key", async () => {
    const { document_id: id } = await create(writer);
    expect((await cancel(id, other, { reason: 'Error en el importe' }, 'k-1')).statusCode).toBe(
      404,
    );
    expect((await cancel(id, reader, { reason: 'Error en el importe' }, 'k-2')).statusCode).toBe(
      403,
    );
    expect(await handle.db.select().from(issuerEvents)).toHaveLength(0);
  });
});
