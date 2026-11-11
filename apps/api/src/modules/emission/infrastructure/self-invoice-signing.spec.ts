import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { seedIssuer } from '../../../../test/support/credit-note-fixture.js';
import { createAcceptSelfInvoice } from '../application/accept-standalone.js';
import type { CertificateSource, CscSource } from '../application/ports/signing.port.js';
import { SignDocument } from '../application/sign-document.js';
import { signingValidationConfig } from '../emission-validation-config.js';
import { createDrizzleAcceptanceUnitOfWork } from './drizzle-acceptance-unit-of-work.js';
import { createDrizzleSigningStore } from './drizzle-signing-store.js';

const CSC = 'ABCD0000000000000000000000000000';

/** Spec: HU-E7-03. An accepted AFE is signed with its QR by the real worker path, addressed to the issuer. */
describe('signing an accepted self-invoice', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let afeId: string;

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
  const afeRow = async () =>
    (await withTenantTransaction(handle.db, tenantId, (tx) => tx.select().from(documents))).find(
      (r) => r.id === afeId,
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
    const place = {
      address: 'Calle 1',
      houseNumber: '10',
      departmentCode: 11,
      districtCode: 143,
      cityCode: 3344,
    };
    const draft = {
      seller: { nature: 1, idType: 1, idNumber: '1234567', name: 'Juan Perez', ...place },
      place,
      certificate: { type: 1, number: '12345678901', control: 'ABCD1234' },
      items: [{ quantity: 2, unitPrice: 50_000, vatRate: 0 as const }],
      roundingPyg: 0,
    };
    const accepted = await createAcceptSelfInvoice({
      unitOfWork: createDrizzleAcceptanceUnitOfWork(handle.db),
      now: () => new Date('2026-03-06T01:30:00Z'),
    })({
      tenantId,
      actor: { type: 'api_key', id: 'k' },
      establishmentCode: '001',
      expeditionPointCode: '002',
      draft,
      payload: {
        type: 'AFE',
        establishment: '001',
        expeditionPoint: '002',
        currency: 'PYG',
        ...draft,
        items: [{ code: 'M-1', description: 'Maiz', unitCode: 77, quantity: 2, unitPrice: 50_000 }],
      },
      idempotencyKey: 'afe-1',
    });
    afeId = accepted.documentId;
  }, 60_000);

  afterEach(async () => {
    await handle.close();
  });

  it('signs the AFE with its QR, an XSD-valid XML, the seller and the issuer as receiver', async () => {
    const result = await signer().execute({ tenantId, documentId: afeId });

    expect(result).toMatchObject({ status: 'signed' });
    const row = await afeRow();
    expect(row?.status).toBe('signed');
    expect(row?.cdc).toMatch(/^04/);
    const xml = row?.signedXml ?? '';
    expect(validateXml(xml, 'siRecepDE')).toMatchObject({ valid: true, errors: [] });
    expect(xml).toMatch(/<iTiDE>4<\/iTiDE>/);
    expect(xml).toContain('<dNomVen>Juan Perez</dNomVen>');
    expect(xml).toContain('<dNumCons>12345678901</dNumCons>');
    expect(xml).toMatch(/<dRucRec>80069563<\/dRucRec>/);
    expect(xml).toContain('<dCarQR>');
  });
});
