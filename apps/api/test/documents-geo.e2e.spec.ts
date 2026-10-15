import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  createPgliteDatabase,
  documents,
  tenantDocumentSequences,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenantFiscalProfiles,
  tenantTimbrados,
  type DatabaseHandle,
} from '@sifen/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTenant, issueApiKey } from '../src/cli/commands.js';
import { createHttpAdapter } from '../src/bootstrap/http.js';
import { AppModule } from '../src/app.module.js';
import { DATABASE, DATABASE_HANDLE } from '../src/modules/database/database.module.js';

/** Ciudad del Este: department 11, district 145, city 3383 (DNIT table, Nov 2025). */
const BODY = {
  establishment: '001',
  expeditionPoint: '002',
  operationType: 'B2B',
  receiver: {
    kind: 'named',
    ruc: '80069563-1',
    isPublicEntity: false,
    name: 'Cliente SA',
    address: 'Av. Principal',
    houseNumber: '1',
    districtCode: 145,
    districtDescription: 'CIUDAD DEL ESTE',
    cityCode: 3383,
    cityDescription: 'CIUDAD DEL ESTE',
  },
  items: [
    {
      code: 'A-001',
      description: 'Servicio de consultoria',
      unitCode: 77,
      quantity: 1,
      unitPrice: 110_000,
      vatRate: 10,
    },
  ],
  roundingPyg: 0,
  location: { departmentCode: 11 },
};

/** Spec: HU-E5-08. Receiver district and city are checked against the DNIT table before a number is burned. */
describe('POST /v1/documents geography (e2e)', () => {
  let handle: DatabaseHandle;
  let app: NestFastifyApplication;
  let bearer: string;
  const originalEnvironment = process.env.SIFEN_ENVIRONMENT;

  beforeEach(async () => {
    process.env.SIFEN_ENVIRONMENT = 'production';
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id } = await createTenant(handle.db, 'Acme SA');
    bearer = (
      await issueApiKey(handle.db, {
        tenantId: id,
        environment: 'live',
        scopes: ['documents:write'],
      })
    ).formattedKey;
    await handle.db.insert(tenantFiscalProfiles).values({
      tenantId: id,
      rucBase: '80069563',
      rucDv: 1,
      legalName: 'Empresa SA',
      taxpayerType: 'persona_juridica',
    });
    const [est] = await handle.db
      .insert(tenantEstablishments)
      .values({
        tenantId: id,
        code: '001',
        address: 'Av. Mariscal Lopez 123',
        houseNumber: '123',
        departmentCode: '11',
        cityCode: '3432',
        cityDescription: 'Asuncion',
      })
      .returning();
    await handle.db
      .insert(tenantExpeditionPoints)
      .values({ tenantId: id, establishmentId: est.id, code: '002' });
    await handle.db
      .insert(tenantTimbrados)
      .values({ tenantId: id, number: '22222222', validFrom: '2020-01-01' });
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

  let sequence = 0;
  const post = (receiver: object, location: object = BODY.location) =>
    app.inject({
      method: 'POST',
      url: '/v1/documents',
      payload: { ...BODY, receiver: { ...BODY.receiver, ...receiver }, location },
      headers: {
        authorization: `Bearer ${bearer}`,
        'idempotency-key': `geo-${String(++sequence)}`,
      },
    });
  const rulesOf = (response: { json: () => unknown }) =>
    (response.json() as { errors: { rule: string; sifenCode?: string }[] }).errors;

  it('accepts a receiver whose codes and descriptions match the table', async () => {
    expect((await post({})).statusCode).toBe(202);
  });

  it.each([
    [
      'a city outside the district',
      { cityCode: 1, cityDescription: 'ASUNCION (DISTRITO)' },
      'receiver-city-not-in-district',
    ],
    ['an unknown city', { cityCode: 99999 }, 'receiver-city-unknown'],
    ['a wrong city description', { cityDescription: 'OTRA' }, 'receiver-city-description-mismatch'],
    [
      'a wrong district description',
      { districtDescription: 'OTRO' },
      'receiver-district-description-mismatch',
    ],
  ])('answers 422 for %s and burns no number', async (_name, receiver, rule) => {
    const response = await post(receiver);

    expect(response.statusCode).toBe(422);
    expect(rulesOf(response).map((e) => e.rule)).toContain(rule);
    expect(await handle.db.select().from(documents)).toHaveLength(0);
    expect(await handle.db.select().from(tenantDocumentSequences)).toHaveLength(0);
  });

  it('answers 422 with the SIFEN code for a description that does not match', async () => {
    const response = await post({ cityDescription: 'OTRA' });

    expect(rulesOf(response)).toContainEqual(
      expect.objectContaining({ rule: 'receiver-city-description-mismatch', sifenCode: '1329' }),
    );
  });

  it('answers 422 for a district outside the department', async () => {
    const response = await post({}, { departmentCode: 1 });

    expect(response.statusCode).toBe(422);
    expect(rulesOf(response).map((e) => e.rule)).toContain('receiver-district-not-in-department');
  });
});
