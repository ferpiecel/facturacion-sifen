import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { createPgliteDatabase, issuerEvents, type DatabaseHandle } from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTenant, issueApiKey } from '../src/cli/commands.js';
import { createHttpAdapter } from '../src/bootstrap/http.js';
import { AppModule } from '../src/app.module.js';
import { DATABASE, DATABASE_HANDLE } from '../src/modules/database/database.module.js';
import { buildCdc } from '../src/modules/emission/domain/cdc.js';
import { seedIssuer } from './support/credit-note-fixture.js';

/** Asunción wall-clock `AAAA-MM-DDThh:mm:ss` of `days` days ago (UTC-3). */
function issuedDaysAgo(days: number): { issuedAt: string; cdc: string } {
  const issuedAt = new Date(Date.now() - days * 86_400_000 - 3 * 3_600_000)
    .toISOString()
    .slice(0, 19);
  const cdc = buildCdc({
    documentType: '01',
    rucBase: '80069563',
    rucDv: 1,
    establishment: '001',
    point: '001',
    documentNumber: '0000001',
    taxpayerType: 1,
    issueDate: issuedAt.slice(0, 10),
    emissionType: 1,
    securityCode: '123456789',
  });
  return { issuedAt, cdc };
}

/** Spec: HU-E9-01. `POST /v1/receiver-events` through the real pipeline. */
describe('POST /v1/receiver-events (e2e)', () => {
  let handle: DatabaseHandle;
  let app: NestFastifyApplication;
  const originalEnvironment = process.env.SIFEN_ENVIRONMENT;
  const recent = issuedDaysAgo(3);

  async function seedTenant(name: string, scopes: string[]) {
    const { id } = await createTenant(handle.db, name);
    const { formattedKey } = await issueApiKey(handle.db, {
      tenantId: id,
      environment: 'live',
      scopes,
    });
    await seedIssuer(handle.db, id);
    return formattedKey;
  }
  const post = (key: string, body: unknown, idempotencyKey?: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/receiver-events',
      payload: body as object,
      headers: {
        authorization: `Bearer ${key}`,
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
    });
  const conformity = (extra: Record<string, unknown> = {}) => ({
    kind: 'conformity',
    conformityType: 'total',
    cdc: recent.cdc,
    issuedAt: recent.issuedAt,
    ...extra,
  });

  let writer: string;
  let reader: string;

  beforeEach(async () => {
    process.env.SIFEN_ENVIRONMENT = 'production';
    handle = createPgliteDatabase();
    await handle.migrate();
    writer = await seedTenant('Acme SA', ['documents:write']);
    reader = await seedTenant('Reader SA', ['documents:read']);
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

  it('answers 202 and stores a pending conformity over the foreign CDC', async () => {
    const response = await post(writer, conformity(), 'k-1');

    expect(response.statusCode).toBe(202);
    const body = response.json<{ event_id: string; kind: string; cdc: string; status: string }>();
    expect(body).toMatchObject({ kind: 'conformity', cdc: recent.cdc, status: 'pending' });
    const [row] = await handle.db.select().from(issuerEvents);
    expect(row).toMatchObject({ id: body.event_id, kind: 'conformity', targetCdc: recent.cdc });
  });

  it('returns the same response for the same key and body, and 409 for another body', async () => {
    const first = await post(writer, conformity(), 'k-1');
    const again = await post(writer, conformity(), 'k-1');
    expect(again.json()).toEqual(first.json());
    const other = conformity({ conformityType: 'partial', estimatedReceiptAt: recent.issuedAt });
    expect((await post(writer, other, 'k-1')).statusCode).toBe(409);
    expect(await handle.db.select().from(issuerEvents)).toHaveLength(1);
  });

  it('answers 409 when the CDC already has that event, with the SIFEN code', async () => {
    await post(writer, conformity(), 'k-1');
    const second = await post(writer, conformity(), 'k-2');

    expect(second.statusCode).toBe(409);
    expect(second.json<{ errors: object[] }>().errors[0]).toMatchObject({
      rule: 'receiver-event-already-registered',
      sifenCode: '4150',
    });
  });

  it('answers 422 with the deadline for an event past the 45 days', async () => {
    const old = issuedDaysAgo(60);
    const response = await post(
      writer,
      conformity({ cdc: old.cdc, issuedAt: old.issuedAt }),
      'k-1',
    );

    expect(response.statusCode).toBe(422);
    expect(response.json<{ errors: object[] }>().errors[0]).toMatchObject({
      rule: 'receiver-event-window-expired',
      sifenCode: '4157',
    });
    expect(await handle.db.select().from(issuerEvents)).toHaveLength(0);
  });

  it('answers 422 for a contradiction (a correction) and for an invalid body, listing the fields', async () => {
    await post(writer, conformity(), 'k-1');
    const contradiction = await post(
      writer,
      {
        ...conformity(),
        kind: 'disconformity',
        reason: 'Mercadería dañada',
        conformityType: undefined,
      },
      'k-2',
    );
    expect(contradiction.statusCode).toBe(422);
    expect(contradiction.json<{ errors: { rule: string }[] }>().errors[0].rule).toBe(
      'receiver-event-needs-correction',
    );

    const invalid = await post(writer, { kind: 'conformity', cdc: '123' }, 'k-3');
    expect(invalid.statusCode).toBe(422);
    const fields = invalid.json<{ errors: { field: string }[] }>().errors.map((e) => e.field);
    expect(fields).toEqual(expect.arrayContaining(['cdc', 'issuedAt', 'conformityType']));
  });

  it('answers 400 without an Idempotency-Key and 403 for a read-only key', async () => {
    expect((await post(writer, conformity())).statusCode).toBe(400);
    expect((await post(reader, conformity(), 'k-9')).statusCode).toBe(403);
  });
});
