import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createPgliteDatabase,
  documents,
  issuerEvents,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenantFiscalEconomicActivities,
  tenantFiscalProfiles,
  tenants,
  tenantTimbrados,
  webhookDeliveries,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import { buildCdc } from '../domain/cdc.js';
import { validateInvoiceDraft } from '../domain/invoice-draft.js';
import {
  DocumentTypeNotSignableError,
  EstablishmentContactMissingError,
  SigningDataIncompleteError,
  type NotAcceptedDocument,
  type SignableDocument,
} from '../application/ports/signing.port.js';
import { seedWebhookEndpoint } from '../../../../test/support/document-seed.js';
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

function asSignable(loaded: SignableDocument | NotAcceptedDocument | null): SignableDocument {
  if (!loaded || !('context' in loaded)) throw new Error('expected a signable document');
  return loaded;
}

/** Spec: HU-E6-02 (S4b). SigningStore over documents + fiscal configuration, under RLS. */
describe('DrizzleSigningStore', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let otherTenantId: string;
  let documentId: string;

  async function seed(
    options: { contact?: boolean; payload?: unknown; documentType?: number } = {},
  ) {
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
        documentType: options.documentType ?? 1,
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
      const loaded = asSignable(await storeFor(tenantId).load(tenantId, documentId));
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
      expect(loaded.context.issuer).toMatchObject({
        legalName: 'Empresa Real SA',
        economicActivities: [{ code: '1254', description: 'Desarrollo de Software' }],
      });
      expect(loaded.context.establishment.code).toBe('001');
      expect(loaded.context.point.code).toBe('001');
      expect(loaded.context.timbrado.number).toBe('12345678');
    });

    it('loads a receiver without address block and without location', async () => {
      const receiver = { kind: 'named', ruc: '80000005-6', name: 'Receptor Prueba SA' };
      const rest = Object.fromEntries(Object.entries(PAYLOAD).filter(([k]) => k !== 'location'));
      await seed({ payload: { ...rest, receiver } });

      const loaded = asSignable(await storeFor(tenantId).load(tenantId, documentId));

      expect(loaded.draft.receiver).toEqual({ kind: 'named', isPublicEntity: false });
      expect(loaded.draft.location).toEqual({});
      expect(loaded.context.receiver).toEqual({ ruc: '80000005-6', name: 'Receptor Prueba SA' });
    });

    it('re-parses an old full named payload into a draft the domain still accepts', async () => {
      const loaded = asSignable(await storeFor(tenantId).load(tenantId, documentId));

      expect(validateInvoiceDraft(loaded.draft, {})).toEqual([]);
    });

    it.each([
      ['carries the department', { location: { departmentCode: 11 } }],
      ['carries no location', { location: undefined }],
    ])('signs an old unnamed payload that %s', async (_name, patch) => {
      await seed({
        payload: { ...PAYLOAD, operationType: 'B2C', receiver: { kind: 'unnamed' }, ...patch },
      });

      const loaded = asSignable(await storeFor(tenantId).load(tenantId, documentId));

      expect(loaded.draft.receiver).toEqual({ kind: 'unnamed' });
      expect(loaded.context.receiver).toBeUndefined();
      expect(validateInvoiceDraft(loaded.draft, {})).toEqual([]);
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
      const loaded = asSignable(await storeFor(tenantId).load(tenantId, documentId));
      expect(loaded).toMatchObject({ environment: 'test', tenantEnvironment: 'production' });
    });
  });

  describe('an NCE or NDE over an FE issued to an unnamed receiver (HU-E8-05)', () => {
    const NOMINATED = {
      kind: 'taxpayer',
      ruc: '80012345-1',
      taxpayerType: 2,
      name: 'Cliente Nominado SA',
      country: 'PRY',
      operationType: 'B2B',
      address: 'Avda Nominada',
      houseNumber: '12',
      departmentCode: 11,
      districtCode: 143,
      cityCode: 3344,
      email: 'nominado@test.com',
    };
    const NOTE_CDC = buildCdc({
      documentType: '05',
      rucBase: '80000001',
      rucDv: 3,
      establishment: '001',
      point: '001',
      documentNumber: '0000001',
      taxpayerType: 2,
      issueDate: '2026-09-30',
      emissionType: 1,
      securityCode: '111111111',
    });

    async function seedNote(nomination: 'approved' | 'pending' | 'none', documentType = 5) {
      await seed({
        payload: { ...PAYLOAD, operationType: 'B2C', receiver: { kind: 'unnamed' } },
      });
      const { db } = handle;
      const [fe] = await db.select().from(documents).where(eq(documents.id, documentId));
      if (nomination !== 'none') {
        const [event] = await db
          .insert(issuerEvents)
          .values({
            tenantId,
            environment: 'test',
            kind: 'nomination',
            eventId: 7n,
            reason: 'Cliente identificado',
            documentId,
            nomination: NOMINATED,
          })
          .returning();
        if (nomination === 'approved') {
          const steps = [
            { status: 'signed', signedXml: '<a/>', signedAt: new Date() },
            { status: 'sending', batchDId: 3n, sendAttemptedAt: new Date() },
            {
              status: 'approved',
              responseCode: '0600',
              responseMessage: 'ok',
              respondedAt: new Date(),
            },
          ] as const;
          for (const set of steps) {
            await db.update(issuerEvents).set(set).where(eq(issuerEvents.id, event.id));
          }
        }
      }
      const [note] = await db
        .insert(documents)
        .values({
          tenantId,
          environment: 'test',
          cdc: NOTE_CDC,
          documentType,
          timbradoId: fe.timbradoId,
          establishmentId: fe.establishmentId,
          expeditionPointId: fe.expeditionPointId,
          number: 1,
          securityCode: '111111111',
          issuedAt: new Date('2026-09-30T14:00:00Z'),
          totalAmount: '5000',
          associatedCdc: CDC,
          payload: {
            type: documentType === 5 ? 'NCE' : 'NDE',
            establishment: '001',
            expeditionPoint: '001',
            associatedCdc: CDC,
            reasonCode: 2,
            items: [PAYLOAD.items[0]],
            roundingPyg: 0,
          },
        })
        .returning();
      documentId = note.id;
    }

    it.each([
      ['an NCE', 5],
      ['an NDE', 6],
    ])('takes the nominated receiver for %s once the nomination is approved', async (_n, type) => {
      await seedNote('approved', type);

      const loaded = asSignable(await storeFor(tenantId).load(tenantId, documentId));

      expect(loaded.draft.receiver).toMatchObject({ kind: 'named' });
      expect(loaded.draft.operationType).toBe('B2B');
      expect(loaded.draft.location).toEqual({ departmentCode: 11 });
      expect(loaded.context.receiver).toMatchObject({ nominated: { ruc: '80012345-1' } });
    });

    it.each(['pending', 'none'] as const)(
      'stays unsignable while the nomination is %s',
      async (state) => {
        await seedNote(state);

        const loaded = asSignable(await storeFor(tenantId).load(tenantId, documentId));

        expect(loaded.draft.receiver).toEqual({ kind: 'unnamed' });
        expect(loaded.context.receiver).toBeUndefined();
      },
    );
  });

  it('returns early, without reading configuration or the payload, when not accepted', async () => {
    // A payload that would make a full load throw: a signed document must never be parsed again.
    await seed({ payload: 'not an invoice' });
    await handle.db
      .update(documents)
      .set({ status: 'signed', signedXml: '<rDE/>', signedAt: new Date('2026-09-30T13:00:05Z') })
      .where(eq(documents.id, documentId));
    expect(await storeFor(tenantId).load(tenantId, documentId)).toEqual({
      documentId,
      status: 'signed',
    });
  });

  it('holds a document of a type with no XML builder (a retention, 8), naming the type, not the payload', async () => {
    // Only the FE (1), AFE (4), NCE (5), NDE (6) and NRE (7) have a builder; any other type waits with its own reason.
    await seed({ documentType: 8, payload: { type: 'RET' } });
    const error = await storeFor(tenantId)
      .load(tenantId, documentId)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DocumentTypeNotSignableError);
    expect((error as DocumentTypeNotSignableError).documentType).toBe(8);
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
    const receiver = without(PAYLOAD.receiver, 'name', 'ruc');
    const item = without(PAYLOAD.items[0], 'code', 'description');
    await seed({ payload: { ...PAYLOAD, receiver, items: [item] } });
    const error = await storeFor(tenantId)
      .load(tenantId, documentId)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SigningDataIncompleteError);
    expect((error as SigningDataIncompleteError).missing).toEqual(
      expect.arrayContaining([
        'receiver.name',
        'receiver.ruc',
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

    it('enqueues one document.signed event, and none when nothing was signed (outbox)', async () => {
      await seedWebhookEndpoint(handle.db, tenantId);
      const store = storeFor(tenantId);
      await store.markSigned(tenantId, documentId, signed);
      await store.markSigned(tenantId, documentId, signed);
      const rows = await handle.db.select().from(webhookDeliveries);
      expect(rows.map((r) => r.eventType)).toEqual(['document.signed']);
    });

    it("does not touch another tenant's document", async () => {
      expect(await storeFor(otherTenantId).markSigned(otherTenantId, documentId, signed)).toBe(
        false,
      );
      expect((await readDocument()).status).toBe('accepted');
    });
  });
});
