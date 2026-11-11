import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createPgliteDatabase,
  documents,
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
  seedIssuer,
} from '../../../../test/support/credit-note-fixture.js';
import { createAcceptCreditNote } from '../application/accept-credit-note.js';
import {
  SigningDataIncompleteError,
  type CertificateSource,
  type CscSource,
} from '../application/ports/signing.port.js';
import { DETERMINISTIC_SIGNING_ERRORS } from '../../transmission/application/transmission-cycle.js';
import { SignDocument } from '../application/sign-document.js';
import { signingValidationConfig } from '../emission-validation-config.js';
import { createDrizzleAcceptanceUnitOfWork } from './drizzle-acceptance-unit-of-work.js';
import { createDrizzleSigningStore } from './drizzle-signing-store.js';

const CSC = 'ABCD0000000000000000000000000000';

/** Spec: HU-E7-01 T7. An accepted NCE is signed with its QR by the real worker path, no longer held. */
describe('signing an accepted credit note', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let feCdc: string;
  let creditId: string;

  const certificates: CertificateSource = {
    open: () => {
      const { p12, password } = generateDevCertificate();
      return Promise.resolve({ p12: Buffer.from(p12), password });
    },
  };
  const cscs: CscSource = {
    get: () => Promise.resolve({ idCsc: '0001', value: Buffer.from(CSC) }),
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
  const creditRow = async () =>
    (await withTenantTransaction(handle.db, tenantId, (tx) => tx.select().from(documents))).find(
      (r) => r.id === creditId,
    );

  beforeEach(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const [tenant] = await handle.db.insert(tenants).values({ name: 'A' }).returning();
    tenantId = tenant.id;
    await seedIssuer(handle.db, tenantId);
    await handle.db
      .insert(tenantFiscalEconomicActivities)
      .values({ tenantId, code: '1254', description: 'Desarrollo de Software' });
    feCdc = (await acceptInvoiceWithStatus(handle.db, tenantId, 'fe-1')).cdc;
    const draft = {
      associatedCdc: feCdc,
      reasonCode: 2,
      items: [{ quantity: 1, unitPrice: 400_000, vatRate: 10 as const }],
      roundingPyg: 0,
    };
    const accepted = await createAcceptCreditNote({
      unitOfWork: createDrizzleAcceptanceUnitOfWork(handle.db),
      now: () => new Date('2026-03-06T01:30:00Z'),
    })({
      tenantId,
      actor: { type: 'api_key', id: 'k' },
      establishmentCode: '001',
      expeditionPointCode: '002',
      draft,
      payload: {
        type: 'NCE',
        establishment: '001',
        expeditionPoint: '002',
        currency: 'PYG',
        ...draft,
        items: [{ code: 'D-1', description: 'Devolucion', unitCode: 77, ...draft.items[0] }],
      },
      idempotencyKey: 'nce-1',
    });
    creditId = accepted.documentId;
  }, 60_000);

  afterEach(async () => {
    await handle.close();
  });

  it('signs the NCE, with its QR, an XSD-valid XML and the FE receiver and association', async () => {
    const result = await signer().execute({ tenantId, documentId: creditId });

    expect(result).toMatchObject({ status: 'signed' });
    const row = await creditRow();
    expect(row?.status).toBe('signed');
    const xml = row?.signedXml ?? '';
    expect(validateXml(xml, 'siRecepDE')).toMatchObject({ valid: true, errors: [] });
    expect(xml).toMatch(/<iTiDE>5<\/iTiDE>/);
    expect(xml).toContain(`<dCdCDERef>${feCdc}</dCdCDERef>`);
    expect(xml).toContain('<dNomRec>Cliente SA</dNomRec>');
    expect(xml).toContain(`<DE Id="${row?.cdc ?? ''}"`);
    expect(xml).toContain('<dCarQR>');
    expect(xml).not.toContain('<gCamCond>');
  });

  describe('a credit note that cannot be built is refused deterministically (held, never retried)', () => {
    let copies = 0;
    /** A second NCE row, cloned from the accepted one, with fields overridden. */
    async function insertCredit(overrides: Partial<typeof documents.$inferInsert>) {
      const [base] = await handle.db.select().from(documents).where(eq(documents.id, creditId));
      copies += 1;
      const [row] = await handle.db
        .insert(documents)
        .values({
          ...base,
          ...overrides,
          id: undefined,
          cdc: `05${String(copies).padStart(42, '7')}`,
          number: 10 + copies,
          idempotencyKey: `copy-${String(copies)}`,
        })
        .returning();
      return row.id;
    }
    const refuses = (id: string) =>
      expect(signer().execute({ tenantId, documentId: id })).rejects.toBeInstanceOf(
        SigningDataIncompleteError,
      );

    it('when the associated FE is missing', async () => {
      await refuses(await insertCredit({ associatedCdc: `01${'9'.repeat(42)}` }));
    });

    it('when the payload of the associated FE can no longer be read', async () => {
      const [fe] = await handle.db.select().from(documents).where(eq(documents.cdc, feCdc));
      const broken = await handle.db
        .insert(documents)
        .values({
          ...fe,
          id: undefined,
          cdc: `01${'8'.repeat(42)}`,
          number: 5,
          idempotencyKey: 'broken-fe',
          payload: { legacy: true },
        })
        .returning();
      await refuses(await insertCredit({ associatedCdc: broken[0].cdc }));
    });

    it('when its own payload is invalid', async () => {
      await refuses(await insertCredit({ payload: { type: 'NCE' } }));
    });

    it('and the transmission cycle parks that error without retrying', () => {
      expect(DETERMINISTIC_SIGNING_ERRORS.has('SigningDataIncompleteError')).toBe(true);
    });
  });
});
