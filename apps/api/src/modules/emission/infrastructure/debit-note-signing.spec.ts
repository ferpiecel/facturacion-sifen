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
import { SigningDataIncompleteError } from '../application/ports/signing.port.js';
import { createAcceptDebitNote } from '../application/accept-credit-note.js';
import type { CertificateSource, CscSource } from '../application/ports/signing.port.js';
import { SignDocument } from '../application/sign-document.js';
import { signingValidationConfig } from '../emission-validation-config.js';
import { createDrizzleAcceptanceUnitOfWork } from './drizzle-acceptance-unit-of-work.js';
import { createDrizzleSigningStore } from './drizzle-signing-store.js';

const CSC = 'ABCD0000000000000000000000000000';

/** Spec: HU-E7-02. An accepted NDE is signed with its QR by the real worker path, no longer held. */
describe('signing an accepted debit note', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let feCdc: string;
  let debitId: string;

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
  const debitRow = async () =>
    (await withTenantTransaction(handle.db, tenantId, (tx) => tx.select().from(documents))).find(
      (r) => r.id === debitId,
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
    const accepted = await createAcceptDebitNote({
      unitOfWork: createDrizzleAcceptanceUnitOfWork(handle.db),
      now: () => new Date('2026-03-06T01:30:00Z'),
    })({
      tenantId,
      actor: { type: 'api_key', id: 'k' },
      establishmentCode: '001',
      expeditionPointCode: '002',
      draft,
      payload: {
        type: 'NDE',
        establishment: '001',
        expeditionPoint: '002',
        currency: 'PYG',
        ...draft,
        items: [{ code: 'D-1', description: 'Devolucion', unitCode: 77, ...draft.items[0] }],
      },
      idempotencyKey: 'nde-1',
    });
    debitId = accepted.documentId;
  }, 60_000);

  afterEach(async () => {
    await handle.close();
  });

  it('signs the NDE, with its QR, an XSD-valid XML and the FE receiver and association', async () => {
    const result = await signer().execute({ tenantId, documentId: debitId });

    expect(result).toMatchObject({ status: 'signed' });
    const row = await debitRow();
    expect(row?.status).toBe('signed');
    expect(row?.cdc).toMatch(/^06/);
    const xml = row?.signedXml ?? '';
    expect(validateXml(xml, 'siRecepDE')).toMatchObject({ valid: true, errors: [] });
    expect(xml).toMatch(/<iTiDE>6<\/iTiDE>/);
    expect(xml).toContain(`<dCdCDERef>${feCdc}</dCdCDERef>`);
    expect(xml).toContain('<dNomRec>Cliente SA</dNomRec>');
    expect(xml).toContain(`<DE Id="${row?.cdc ?? ''}"`);
    expect(xml).toContain('<dCarQR>');
    expect(xml).not.toContain('<gCamCond>');
  });

  it('refuses an NDE whose associated FE is missing, deterministically', async () => {
    const [base] = await handle.db.select().from(documents).where(eq(documents.id, debitId));
    const [row] = await handle.db
      .insert(documents)
      .values({
        ...base,
        id: undefined,
        cdc: `06${'7'.repeat(42)}`,
        number: 11,
        idempotencyKey: 'copy-1',
        associatedCdc: `01${'9'.repeat(42)}`,
      })
      .returning();
    await expect(signer().execute({ tenantId, documentId: row.id })).rejects.toBeInstanceOf(
      SigningDataIncompleteError,
    );
  });
});
