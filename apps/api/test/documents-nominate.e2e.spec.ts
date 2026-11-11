import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { createPgliteDatabase, issuerEvents, type DatabaseHandle } from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTenant, issueApiKey } from '../src/cli/commands.js';
import { createHttpAdapter } from '../src/bootstrap/http.js';
import { AppModule } from '../src/app.module.js';
import { DATABASE, DATABASE_HANDLE } from '../src/modules/database/database.module.js';
import { acceptInvoiceWithStatus, FE_BODY, seedIssuer } from './support/credit-note-fixture.js';

const UNNAMED_FE = { ...FE_BODY, operationType: 'B2C', receiver: { kind: 'unnamed' } };
const RECEIVER = {
  kind: 'non-taxpayer',
  documentType: 1,
  documentNumber: '1234567',
  name: 'Juan Pérez',
  country: 'PRY',
  operationType: 'B2C',
};
const BODY = { receiver: RECEIVER, reason: 'El cliente pidió su factura' };

/** Spec: HU-E8-05. `POST /v1/documents/{id}/nominate` through the real pipeline. */
describe('POST /v1/documents/{id}/nominate (e2e)', () => {
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
  const create = async (key: string, body: unknown = UNNAMED_FE, status = 'approved') =>
    (
      await acceptInvoiceWithStatus(
        handle.db,
        tenantIds.get(key) ?? '',
        `n-${String(++sequence)}`,
        status,
        body,
      )
    ).documentId;
  const nominate = (id: string, key: string, body: unknown, idempotencyKey?: string) =>
    app.inject({
      method: 'POST',
      url: `/v1/documents/${id}/nominate`,
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

  it('answers 202 and stores a pending nomination with the receiver', async () => {
    const id = await create(writer);

    const response = await nominate(id, writer, BODY, 'k-1');

    expect(response.statusCode).toBe(202);
    const body = response.json<{ event_id: string; document_id: string; status: string }>();
    expect(body).toMatchObject({ document_id: id, status: 'pending' });
    const rows = await handle.db.select().from(issuerEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: body.event_id,
      kind: 'nomination',
      status: 'pending',
      nomination: RECEIVER,
    });
  });

  it('returns the same response for the same key and body, and 409 for another body', async () => {
    const id = await create(writer);
    const first = await nominate(id, writer, BODY, 'k-1');
    const again = await nominate(id, writer, BODY, 'k-1');
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual(first.json());
    const changed = { ...BODY, reason: 'Otro motivo distinto' };
    expect((await nominate(id, writer, changed, 'k-1')).statusCode).toBe(409);
    expect(await handle.db.select().from(issuerEvents)).toHaveLength(1);
  });

  it('answers 409 with 4453 when the document already has a nomination', async () => {
    const id = await create(writer);
    await nominate(id, writer, BODY, 'k-1');
    const second = await nominate(id, writer, BODY, 'k-2');
    expect(second.statusCode).toBe(409);
    expect(
      second.json<{ errors: { rule: string; sifenCode: string }[] }>().errors[0],
    ).toMatchObject({ rule: 'nomination-already-requested', sifenCode: '4453' });
  });

  it('answers 422 with the rule for a named receiver (4469)', async () => {
    const id = await create(writer, FE_BODY);
    const response = await nominate(id, writer, BODY, 'k-1');
    expect(response.statusCode).toBe(422);
    expect(
      response.json<{ errors: { rule: string; sifenCode: string }[] }>().errors[0],
    ).toMatchObject({ rule: 'nominate-receiver-named', sifenCode: '4469' });
    expect(await handle.db.select().from(issuerEvents)).toHaveLength(0);
  });

  it('answers 422 for a document SIFEN has not approved (4002)', async () => {
    const id = await create(writer, UNNAMED_FE, 'signed');
    const response = await nominate(id, writer, BODY, 'k-1');
    expect(response.statusCode).toBe(422);
    expect(response.json<{ errors: { sifenCode: string }[] }>().errors[0].sifenCode).toBe('4002');
  });

  it('answers 422 for a malformed receiver and for a reason out of range', async () => {
    const id = await create(writer);
    const badReceiver = { ...BODY, receiver: { ...RECEIVER, operationType: 'B2B' } };
    const receiver = await nominate(id, writer, badReceiver, 'k-1');
    expect(receiver.statusCode).toBe(422);
    expect(receiver.json<{ errors: { field: string }[] }>().errors[0].field).toBe(
      'receiver.operationType',
    );
    const reason = await nominate(id, writer, { ...BODY, reason: 'no' }, 'k-2');
    expect(reason.statusCode).toBe(422);
    expect(reason.json<{ errors: { field: string }[] }>().errors[0].field).toBe('reason');
  });

  it('answers 400 without an Idempotency-Key or with a malformed id', async () => {
    const id = await create(writer);
    expect((await nominate(id, writer, BODY)).statusCode).toBe(400);
    expect((await nominate('nope', writer, BODY, 'k')).statusCode).toBe(400);
  });

  it("answers 404 for another tenant's document and 403 for a read-only key", async () => {
    const id = await create(writer);
    expect((await nominate(id, other, BODY, 'k-1')).statusCode).toBe(404);
    expect((await nominate(id, reader, BODY, 'k-2')).statusCode).toBe(403);
    expect(await handle.db.select().from(issuerEvents)).toHaveLength(0);
  });
});
