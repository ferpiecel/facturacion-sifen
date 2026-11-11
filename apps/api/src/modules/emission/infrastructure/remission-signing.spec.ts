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
import { createAcceptRemission } from '../application/accept-standalone.js';
import type { CertificateSource, CscSource } from '../application/ports/signing.port.js';
import type { RemissionDraft } from '../domain/remission-draft.js';
import { SignDocument } from '../application/sign-document.js';
import { signingValidationConfig } from '../emission-validation-config.js';
import { createDrizzleAcceptanceUnitOfWork } from './drizzle-acceptance-unit-of-work.js';
import { createDrizzleSigningStore } from './drizzle-signing-store.js';

const CSC = 'ABCD0000000000000000000000000000';

/** Spec: HU-E7-04. An accepted NRE is signed with its QR by the real worker path, with the transport. */
describe('signing an accepted remission note', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let nreId: string;

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
  const nreRow = async () =>
    (await withTenantTransaction(handle.db, tenantId, (tx) => tx.select().from(documents))).find(
      (r) => r.id === nreId,
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
    const draft: RemissionDraft = {
      motive: 1,
      responsible: 1,
      km: 120,
      receiver: { ruc: '80000001-3', name: 'Empresa Real SA', ...place },
      transport: {
        type: 1,
        modality: 1,
        freightResponsible: 1,
        startDate: '2026-03-07',
        endDate: '2026-03-08',
        departure: place,
        delivery: { ...place, address: 'Calle 2' },
        vehicle: { type: 'Camion', brand: 'Volvo', idType: 1, idNumber: 'ABC12345' },
        carrier: {
          contributor: true,
          name: 'Transportes SA',
          ruc: '80000002-1',
          address: 'Ruta 1',
          driver: { name: 'Pedro Gomez', idNumber: '2345678', address: 'Calle 3' },
        },
      },
      items: [{ quantity: 2 }],
    };
    const accepted = await createAcceptRemission({
      unitOfWork: createDrizzleAcceptanceUnitOfWork(handle.db),
      now: () => new Date('2026-03-06T01:30:00Z'),
    })({
      tenantId,
      actor: { type: 'api_key', id: 'k' },
      establishmentCode: '001',
      expeditionPointCode: '002',
      draft,
      payload: {
        type: 'NRE',
        establishment: '001',
        expeditionPoint: '002',
        ...draft,
        items: [{ code: 'M-1', description: 'Maiz', unitCode: 77, quantity: 2 }],
      },
      idempotencyKey: 'nre-1',
    });
    nreId = accepted.documentId;
  }, 60_000);

  afterEach(async () => {
    await handle.close();
  });

  it('signs the NRE with its QR, an XSD-valid XML and the transport', async () => {
    const result = await signer().execute({ tenantId, documentId: nreId });

    expect(result).toMatchObject({ status: 'signed' });
    const row = await nreRow();
    expect(row?.status).toBe('signed');
    expect(row?.cdc).toMatch(/^07/);
    const xml = row?.signedXml ?? '';
    expect(validateXml(xml, 'siRecepDE')).toMatchObject({ valid: true, errors: [] });
    expect(xml).toMatch(/<iTiDE>7<\/iTiDE>/);
    expect(xml).toContain('<dKmR>120</dKmR>');
    expect(xml).toContain('<dNomChof>Pedro Gomez</dNomChof>');
    expect(xml).toMatch(/<dRucRec>80000001<\/dRucRec>/);
    expect(xml).toContain('<dCarQR>');
  });
});
