import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createPgliteDatabase,
  documents,
  lotes,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenantFiscalEconomicActivities,
  tenantFiscalProfiles,
  tenants,
  tenantTimbrados,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import { FakeSifenGateway, SifenTimeoutError, sifenScenarios, toCdc } from '@sifen/sifen-gateway';
import { generateDevCertificate } from '../../../../test/support/dev-certificate.js';
import { createTenantCycleFactory } from '../../../worker/tenant-cycle-factory.js';
import { buildCdc } from '../../emission/domain/cdc.js';

const CDC = buildCdc({
  documentType: '01',
  rucBase: '80000001',
  rucDv: 3,
  establishment: '001',
  point: '001',
  documentNumber: '0000001',
  taxpayerType: 2,
  issueDate: '2026-09-30',
  emissionType: 1,
  securityCode: '298398000',
});

// The payload carries the receiver and item fields the DE needs (the request schema extension, HU-E5).
const PAYLOAD = {
  establishment: '001',
  expeditionPoint: '001',
  operationType: 'B2B',
  receiver: {
    kind: 'named',
    ruc: '80000005-6',
    isPublicEntity: false,
    name: 'Receptor Prueba SA',
    address: 'Avda Prueba',
    houseNumber: '100',
    districtCode: 143,
    districtDescription: 'DOMINGO MARTINEZ DE IRALA',
    cityCode: 3344,
    cityDescription: 'PASO ITA (INDIGENA)',
  },
  items: [
    {
      quantity: 2,
      unitPrice: 5000,
      vatRate: 10,
      code: 'A-001',
      description: 'Servicio',
      unitCode: 77,
    },
  ],
  roundingPyg: 0,
  location: { departmentCode: 11 },
  currency: 'PYG',
};

/** Spec: HU-E6-02 (S5b). An accepted document reaches `approved` through the real adapters and the SIFEN simulator. */
describe('TransmissionCycle end to end', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let clock: Date;

  beforeEach(async () => {
    clock = new Date('2026-10-02T12:00:00Z');
    handle = createPgliteDatabase();
    await handle.migrate();
    const { db } = handle;
    const [tenant] = await db.insert(tenants).values({ name: 'A' }).returning();
    tenantId = tenant.id;
    await db.insert(tenantFiscalProfiles).values({
      tenantId,
      rucBase: '80000001',
      rucDv: 3,
      legalName: 'Empresa Real SA',
      tradeName: 'Empresa Real',
      taxpayerType: 'persona_juridica',
      regimeCode: '8',
    });
    await db
      .insert(tenantFiscalEconomicActivities)
      .values({ tenantId, code: '1254', description: 'Desarrollo de Software' });
    const [est] = await db
      .insert(tenantEstablishments)
      .values({
        tenantId,
        code: '001',
        address: 'Calle Falsa',
        houseNumber: '123',
        departmentCode: '11',
        districtCode: '145',
        districtDescription: 'CIUDAD DEL ESTE',
        cityCode: '3432',
        cityDescription: 'PUERTO PTE.STROESSNER (MUNIC)',
        phone: '0973-000000',
        email: 'emisor@test.com',
        commercialName: 'Casa Matriz',
      })
      .returning();
    const [point] = await db
      .insert(tenantExpeditionPoints)
      .values({ tenantId, establishmentId: est.id, code: '001' })
      .returning();
    const [timbrado] = await db
      .insert(tenantTimbrados)
      .values({ tenantId, number: '12345678', validFrom: '2024-01-01' })
      .returning();
    await db.insert(documents).values({
      tenantId,
      environment: 'test',
      cdc: CDC,
      documentType: 1,
      timbradoId: timbrado.id,
      establishmentId: est.id,
      expeditionPointId: point.id,
      number: 1,
      securityCode: '298398000',
      issuedAt: new Date('2026-09-30T13:00:00Z'),
      totalAmount: '10000',
      payload: PAYLOAD,
    });
  });

  afterEach(async () => {
    await handle.close();
  });

  function buildCycle(gateway: FakeSifenGateway, options: { csc?: boolean } = {}) {
    const { db } = handle;
    const dev = generateDevCertificate();
    const now = () => clock;
    return createTenantCycleFactory({
      db,
      gateway,
      now,
      certificates: {
        open: () => Promise.resolve({ p12: Buffer.from(dev.p12), password: dev.password }),
      },
      cscs: {
        get: () =>
          Promise.resolve(
            options.csc === false
              ? null
              : { idCsc: '0001', value: Buffer.from('ABCD0000000000000000000000000000') },
          ),
      },
    })(tenantId);
  }

  const readDocument = () =>
    withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(documents).where(eq(documents.cdc, CDC)),
    ).then((rows) => rows[0]);

  it('takes an accepted document through signed, queued and submitted to approved', async () => {
    const gateway = new FakeSifenGateway();
    gateway.enqueue('enviarLote', sifenScenarios.loteRecibido('4500123'));
    const cycle = buildCycle(gateway);

    const first = await cycle.run();

    expect(first).toMatchObject({ signed: 1, assembled: 1, failures: [] });
    expect(first.sent.map((s) => s.status)).toEqual(['sent']);
    const submitted = await readDocument();
    expect(submitted.status).toBe('submitted');
    expect(submitted.signedXml).toContain('<Signature');
    expect(gateway.callsTo('enviarLote')).toEqual([[{ dId: 1n, des: [submitted.signedXml] }]]);

    // Not due yet: the lote may only be queried 10 minutes after it was sent.
    expect((await cycle.run()).polled).toEqual([]);

    clock = new Date('2026-10-02T12:11:00Z');
    gateway.enqueue(
      'consultarLote',
      sifenScenarios.loteConcluido([{ cdc: toCdc(CDC), dEstRes: 'Aprobado', mensajes: [] }]),
    );
    const last = await cycle.run();

    expect(last.polled).toEqual([{ loteId: first.sent[0].loteId, status: 'processed' }]);
    expect((await readDocument()).status).toBe('approved');
    const [lote] = await withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(lotes),
    );
    expect(lote.status).toBe('processed');

    // Nothing is left to do: another run neither resends nor requeries.
    expect(await cycle.run()).toMatchObject({ signed: 0, assembled: 0, sent: [], polled: [] });
    expect(gateway.callsTo('enviarLote')).toHaveLength(1);
    expect(gateway.callsTo('consultarLote')).toHaveLength(1);
  });

  it('recovers a lote by CDC after the 48 h window without ever resending it (HU-E6-04)', async () => {
    const gateway = new FakeSifenGateway();
    gateway.enqueue('enviarLote', sifenScenarios.loteRecibido('4500123'));
    const cycle = buildCycle(gateway);
    const first = await cycle.run();
    const loteId = first.sent[0].loteId;

    // 48 h later SIFEN no longer answers lote queries (0364): the lote is handed to recovery.
    clock = new Date('2026-10-04T12:11:00Z');
    gateway.enqueue('consultarLote', sifenScenarios.loteConcluido([]));
    expect((await cycle.run()).polled).toEqual([{ loteId, status: 'recovery' }]);
    expect((await readDocument()).status).toBe('submitted');

    // Pacing: not queried by CDC until 10 minutes after the hand-over.
    expect((await cycle.run()).recovered).toEqual([]);

    // Past the 48 h window a 0420 is definitive: the document is held (alert), the lote leaves
    // recovery and nothing is resent.
    clock = new Date('2026-10-04T12:22:00Z');
    gateway.enqueue('consultarDE', sifenScenarios.cdcInexistente());
    expect((await cycle.run()).recovered).toEqual([{ loteId, status: 'incomplete' }]);
    expect(await readDocument()).toMatchObject({
      status: 'submitted',
      transmissionHold: 'recovery:0420-unresolved',
    });
    const [settled] = await withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(lotes),
    );
    expect(settled.status).toBe('processed');
    clock = new Date('2026-10-04T12:40:00Z');
    expect((await cycle.run()).recovered).toEqual([]);

    // An operator releases the hold; the document is queried again and SIFEN now has it (0422).
    await withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.update(documents).set({ transmissionHold: null }).where(eq(documents.cdc, CDC)),
    );
    gateway.enqueue('consultarDE', sifenScenarios.cdcEncontrado(`<rDE><DE Id="${CDC}"/></rDE>`));
    expect((await cycle.run()).recovered).toEqual([{ loteId, status: 'recovered' }]);
    expect((await readDocument()).status).toBe('approved');

    expect((await cycle.run()).recovered).toEqual([]);
    expect(gateway.callsTo('enviarLote')).toHaveLength(1);
    expect(gateway.callsTo('consultarDE')).toHaveLength(2);
  });

  it('recovers a send that got no answer by CDC and never resends it (HU-E6-04)', async () => {
    const gateway = new FakeSifenGateway();
    gateway.enqueue('enviarLote', new SifenTimeoutError('enviarLote'));
    gateway.enqueue('consultarDE', sifenScenarios.cdcInexistente());
    const cycle = buildCycle(gateway);

    const first = await cycle.run();
    const loteId = first.sent[0].loteId;
    expect(first.sent[0].status).toBe('unknown');
    // SIFEN does not know the CDC yet (0420): the document stays queued and nothing is resent.
    expect(first.recovered).toEqual([{ loteId, status: 'incomplete' }]);
    expect((await readDocument()).status).toBe('queued');

    // The next run (still inside the pacing window) neither queries nor resends.
    expect(await cycle.run()).toMatchObject({ sent: [], recovered: [], assembled: 0 });

    clock = new Date('2026-10-02T12:11:00Z');
    gateway.enqueue('consultarDE', sifenScenarios.cdcEncontrado(`<rDE><DE Id="${CDC}"/></rDE>`));
    expect((await cycle.run()).recovered).toEqual([{ loteId, status: 'recovered' }]);
    expect((await readDocument()).status).toBe('approved');
    const [lote] = await withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(lotes),
    );
    expect(lote.status).toBe('processed');
    expect(gateway.callsTo('enviarLote')).toHaveLength(1);
  });

  it('parks a document whose signing can never succeed and stops retrying it', async () => {
    const gateway = new FakeSifenGateway();
    const cycle = buildCycle(gateway, { csc: false });

    const first = await cycle.run();

    expect(first.failures).toEqual([
      { step: 'sign', id: (await readDocument()).id, error: 'CscNotConfiguredError' },
    ]);
    expect(first.held).toEqual([
      { documentId: (await readDocument()).id, reason: 'signing:CscNotConfiguredError' },
    ]);
    const second = await cycle.run();
    expect(second.failures).toEqual([]);
    expect(second.held).toHaveLength(1);
    expect((await readDocument()).status).toBe('accepted');
  });

  it('backs off after a 0301, retries when due and holds the document at the cap', async () => {
    const gateway = new FakeSifenGateway();
    gateway.setDefault('enviarLote', sifenScenarios.loteNoEncolado('RUC bloqueado'));
    const cycle = buildCycle(gateway);

    await cycle.run();
    expect(await readDocument()).toMatchObject({ status: 'queued', transmissionAttempts: 1 });

    // Backing off: the next run neither assembles nor sends it again.
    expect(await cycle.run()).toMatchObject({ assembled: 0, sent: [] });
    expect(gateway.callsTo('enviarLote')).toHaveLength(1);

    // Waits 5, 10, 20 and 40 minutes between the five attempts; the fifth refusal holds it.
    for (const minutes of [6, 16, 36, 76]) {
      clock = new Date(clock.getTime() + minutes * 60_000);
      await cycle.run();
    }
    expect(gateway.callsTo('enviarLote')).toHaveLength(5);
    expect(await readDocument()).toMatchObject({
      status: 'queued',
      transmissionAttempts: 5,
      transmissionHold: 'transmission:attempts-exhausted',
    });

    clock = new Date(clock.getTime() + 24 * 3_600_000);
    const last = await cycle.run();
    expect(last.sent).toEqual([]);
    expect(last.held).toEqual([
      { documentId: (await readDocument()).id, reason: 'transmission:attempts-exhausted' },
    ]);
  });
});
