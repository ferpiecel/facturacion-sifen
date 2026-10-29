import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createPgliteDatabase,
  documents,
  issuerEvents,
  tenantFiscalEconomicActivities,
  tenants,
  withTenantTransaction,
  type DatabaseHandle,
} from '@sifen/db';
import { validateXml } from '@sifen/sifen-xsd';
import { TipsDeXmlBuilder, TipsQrGenerator, TipsXmlSigner } from '@sifen/sifen-tips';
import { generateDevCertificate } from '../../../../test/support/dev-certificate.js';
import {
  acceptInvoiceWithStatus,
  FE_BODY,
  seedIssuer,
} from '../../../../test/support/credit-note-fixture.js';
import {
  createAcceptCreditNote,
  createAcceptDebitNote,
} from '../application/accept-credit-note.js';
import type { CertificateSource, CscSource } from '../application/ports/signing.port.js';
import { SignDocument } from '../application/sign-document.js';
import { signingValidationConfig } from '../emission-validation-config.js';
import { createDrizzleAcceptanceUnitOfWork } from './drizzle-acceptance-unit-of-work.js';
import { createDrizzleSigningStore } from './drizzle-signing-store.js';

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

/**
 * Spec: HU-E8-05 B3c. An NCE or NDE accepted over an FE issued to "Sin Nombre" whose nomination
 * SIFEN approved is signed by the real worker path with the nominated receiver, XSD-valid.
 */
describe('signing a note over a nominated FE', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let feCdc: string;
  let feId: string;

  const certificates: CertificateSource = {
    open: () => {
      const { p12, password } = generateDevCertificate();
      return Promise.resolve({ p12: Buffer.from(p12), password });
    },
  };
  const cscs: CscSource = {
    get: () =>
      Promise.resolve({ idCsc: '0001', value: Buffer.from('ABCD0000000000000000000000000000') }),
  };
  const signer = () =>
    new SignDocument({
      store: createDrizzleSigningStore({ db: handle.db }),
      certificates,
      cscs,
      builder: new TipsDeXmlBuilder(),
      signer: new TipsXmlSigner(),
      qr: new TipsQrGenerator(),
      validation: signingValidationConfig(),
    });
  const unitOfWork = () => createDrizzleAcceptanceUnitOfWork(handle.db);

  async function approveNomination() {
    const [event] = await handle.db
      .insert(issuerEvents)
      .values({
        tenantId,
        environment: 'test',
        kind: 'nomination',
        eventId: 5n,
        reason: 'Cliente identificado',
        documentId: feId,
        nomination: NOMINATED,
      })
      .returning();
    const steps = [
      { status: 'signed', signedXml: '<a/>', signedAt: new Date() },
      { status: 'sending', batchDId: 3n, sendAttemptedAt: new Date() },
      { status: 'approved', responseCode: '0600', responseMessage: 'ok', respondedAt: new Date() },
    ] as const;
    for (const set of steps) {
      await handle.db.update(issuerEvents).set(set).where(eq(issuerEvents.id, event.id));
    }
  }

  async function acceptNote(type: 'NCE' | 'NDE') {
    const draft = {
      associatedCdc: feCdc,
      reasonCode: 2,
      items: [{ quantity: 1, unitPrice: 55_000, vatRate: 10 as const }],
      roundingPyg: 0,
    };
    const input = {
      tenantId,
      actor: { type: 'api_key' as const, id: 'k' },
      establishmentCode: '001',
      expeditionPointCode: '002',
      draft,
      payload: {
        type,
        establishment: '001',
        expeditionPoint: '002',
        ...draft,
        items: [
          {
            code: 'M-1',
            description: 'Maiz',
            unitCode: 77,
            vatRate: 10,
            quantity: 1,
            unitPrice: 55_000,
          },
        ],
      },
      idempotencyKey: `${type}-1`,
    };
    const deps = { unitOfWork: unitOfWork(), now: () => new Date('2026-03-06T01:30:00Z') };
    const accepted =
      type === 'NCE'
        ? await createAcceptCreditNote(deps)(input)
        : await createAcceptDebitNote(deps)(input);
    return accepted.documentId;
  }

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const [tenant] = await handle.db.insert(tenants).values({ name: 'A' }).returning();
    tenantId = tenant.id;
    await seedIssuer(handle.db, tenantId);
    await handle.db
      .insert(tenantFiscalEconomicActivities)
      .values({ tenantId, code: '1254', description: 'Desarrollo de Software' });
    const body = { ...FE_BODY, operationType: 'B2C', receiver: { kind: 'unnamed' } };
    const fe = await acceptInvoiceWithStatus(handle.db, tenantId, 'fe-1', 'approved', body);
    feCdc = fe.cdc;
    feId = fe.documentId;
    await approveNomination();
  }, 60_000);

  afterEach(async () => {
    await handle.close();
  });

  it.each([
    ['NCE', 5],
    ['NDE', 6],
  ] as const)('accepts and signs an %s to the nominated receiver', async (type, tipo) => {
    const noteId = await acceptNote(type);

    expect(await signer().execute({ tenantId, documentId: noteId })).toMatchObject({
      status: 'signed',
    });

    const [row] = await withTenantTransaction(handle.db, tenantId, (tx) =>
      tx.select().from(documents).where(eq(documents.id, noteId)),
    );
    const xml = row.signedXml ?? '';
    expect(validateXml(xml, 'siRecepDE')).toMatchObject({ valid: true, errors: [] });
    expect(xml).toContain(`<iTiDE>${String(tipo)}</iTiDE>`);
    expect(xml).toContain('<dRucRec>80012345</dRucRec>');
    expect(xml).toContain('<dNomRec>Cliente Nominado SA</dNomRec>');
    expect(xml).not.toContain('Sin Nombre');
  });
});
