import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createPgliteDatabase,
  documents,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenantFiscalEconomicActivities,
  tenantFiscalProfiles,
  tenants,
  tenantTimbrados,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import { buildCdc } from '../domain/cdc.js';
import {
  EstablishmentContactMissingError,
  SigningDataIncompleteError,
} from '../application/ports/signing.port.js';
import { createDrizzleSigningStore } from './drizzle-signing-store.js';

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
      description: 'Servicio real uno',
      unitCode: 77,
    },
  ],
  roundingPyg: 0,
  location: { departmentCode: 11 },
  currency: 'PYG',
};

/** Spec: HU-E6-02 (S4b). SigningStore over documents + fiscal configuration, under RLS. */
describe('DrizzleSigningStore', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let otherTenantId: string;
  let documentId: string;

  async function seed(options: { contact?: boolean; payload?: unknown } = {}) {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { db } = handle;
    const [a, b] = await db
      .insert(tenants)
      .values([{ name: 'A' }, { name: 'B' }])
      .returning();
    tenantId = a.id;
    otherTenantId = b.id;
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
        ...(options.contact === false
          ? {}
          : { phone: '0973-000000', email: 'emisor@test.com', commercialName: 'Casa Matriz' }),
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
    const [document] = await db
      .insert(documents)
      .values({
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
        payload: options.payload ?? PAYLOAD,
      })
      .returning();
    documentId = document.id;
  }

  afterEach(async () => {
    await handle.close();
  });

  const storeFor = (_tenant: string, now?: () => Date) =>
    createDrizzleSigningStore({ db: handle.db, now });
  const readDocument = () =>
    withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(documents).where(eq(documents.id, documentId)),
    ).then((rows) => rows[0]);

  describe('load', () => {
    beforeEach(() => seed());

    it('rebuilds the draft and the XML context from the document and the fiscal configuration', async () => {
      const loaded = await storeFor(tenantId).load(tenantId, documentId);
      expect(loaded).toMatchObject({
        documentId,
        cdc: CDC,
        status: 'accepted',
        environment: 'test',
        tenantEnvironment: 'test',
        draft: {
          operationType: 'B2B',
          receiver: { kind: 'named', isPublicEntity: false },
          items: [{ quantity: 2, unitPrice: 5000, vatRate: 10 }],
          roundingPyg: 0,
          location: { departmentCode: 11 },
        },
        context: {
          environment: 'test',
          issuedAt: new Date('2026-09-30T13:00:00Z'),
          numbering: { documentNumber: '0000001', securityCode: '298398000' },
          establishmentContact: {
            phone: '0973-000000',
            email: 'emisor@test.com',
            name: 'Casa Matriz',
          },
          receiver: {
            ruc: '80000005-6',
            name: 'Receptor Prueba SA',
            districtCode: 143,
            cityCode: 3344,
          },
          lines: [{ code: 'A-001', description: 'Servicio real uno', unitCode: 77 }],
        },
      });
      expect(loaded?.context.issuer).toMatchObject({
        legalName: 'Empresa Real SA',
        economicActivities: [{ code: '1254', description: 'Desarrollo de Software' }],
      });
      expect(loaded?.context.establishment.code).toBe('001');
      expect(loaded?.context.point.code).toBe('001');
      expect(loaded?.context.timbrado.number).toBe('12345678');
    });

    it('is null for an unknown document and for another tenant', async () => {
      expect(
        await storeFor(tenantId).load(tenantId, '00000000-0000-4000-8000-000000000000'),
      ).toBeNull();
      expect(await storeFor(otherTenantId).load(otherTenantId, documentId)).toBeNull();
    });

    it('reports the tenant environment separately from the document one', async () => {
      await handle.db
        .update(tenants)
        .set({ environment: 'production' })
        .where(eq(tenants.id, tenantId));
      const loaded = await storeFor(tenantId).load(tenantId, documentId);
      expect(loaded).toMatchObject({ environment: 'test', tenantEnvironment: 'production' });
    });
  });

  it('names the establishment when it has no phone or email', async () => {
    await seed({ contact: false });
    await expect(storeFor(tenantId).load(tenantId, documentId)).rejects.toThrow(
      EstablishmentContactMissingError,
    );
  });

  it('lists the missing receiver and item data instead of guessing it', async () => {
    const without = (value: object, ...keys: string[]) =>
      Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
    const receiver = without(PAYLOAD.receiver, 'name', 'address');
    const item = without(PAYLOAD.items[0], 'code', 'description');
    await seed({ payload: { ...PAYLOAD, receiver, items: [item] } });
    const error = await storeFor(tenantId)
      .load(tenantId, documentId)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SigningDataIncompleteError);
    expect((error as SigningDataIncompleteError).missing).toEqual(
      expect.arrayContaining([
        'receiver.name',
        'receiver.address',
        'items[0].code',
        'items[0].description',
      ]),
    );
  });

  describe('markSigned', () => {
    beforeEach(() => seed());
    const signed = { signedXml: '<rDE/>', signedAt: new Date('2026-09-30T13:00:05Z') };

    it('stores the XML and moves accepted to signed in one write', async () => {
      const now = new Date('2026-09-30T13:00:06Z');
      expect(await storeFor(tenantId, () => now).markSigned(tenantId, documentId, signed)).toBe(
        true,
      );
      expect(await readDocument()).toMatchObject({
        status: 'signed',
        signedXml: '<rDE/>',
        signedAt: signed.signedAt,
        updatedAt: now,
      });
    });

    it('writes nothing when the document is no longer accepted', async () => {
      const store = storeFor(tenantId);
      await store.markSigned(tenantId, documentId, signed);
      expect(
        await store.markSigned(tenantId, documentId, { ...signed, signedXml: '<rDE>2</rDE>' }),
      ).toBe(false);
      expect((await readDocument()).signedXml).toBe('<rDE/>');
    });

    it('lets only one of two concurrent signers win', async () => {
      const store = storeFor(tenantId);
      const results = await Promise.all([
        store.markSigned(tenantId, documentId, signed),
        store.markSigned(tenantId, documentId, signed),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("does not touch another tenant's document", async () => {
      expect(await storeFor(otherTenantId).markSigned(otherTenantId, documentId, signed)).toBe(
        false,
      );
      expect((await readDocument()).status).toBe('accepted');
    });
  });
});
