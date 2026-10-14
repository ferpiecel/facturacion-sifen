import { beforeAll, describe, expect, it } from 'vitest';
import { TipsDeXmlBuilder, TipsQrGenerator, TipsXmlSigner } from '@sifen/sifen-tips';
import type { LoadedCertificate } from '@sifen/sifen-gateway';
import { context } from '../../../../test/support/invoice-xml-fixture.js';
import { generateDevCertificate } from '../../../../test/support/dev-certificate.js';
import type { DraftItem, InvoiceDraft } from '../domain/invoice-draft.js';
import { addQrToSignedInvoice } from './invoice-qr.js';
import { buildSignedInvoice } from './invoice-signing.js';

const draft = (items: DraftItem[], roundingPyg: number): InvoiceDraft => ({
  receiver: {
    kind: 'named',
    isPublicEntity: false,
    address: { street: 'Avda Prueba', houseNumber: '100', cityCode: 3344 },
  },
  operationType: 'B2B',
  items,
  roundingPyg,
  location: { departmentCode: 11 },
});

const CASES: Record<string, InvoiceDraft> = {
  'integer document': draft([{ quantity: 2, unitPrice: 55_000, vatRate: 10 }], 0),
  '2.3 x 100': draft([{ quantity: 2.3, unitPrice: 100, vatRate: 10 }], 30),
  '0.5 x 1001 at 5% with fractional rounding': draft(
    [{ quantity: 0.5, unitPrice: 1001, vatRate: 5 }],
    0.5,
  ),
  'decimal price and quantity, two rates': draft(
    [
      { quantity: 1.25, unitPrice: 10_000.5, vatRate: 10 },
      { quantity: 3, unitPrice: 333.3333, vatRate: 5 },
    ],
    // 12500.625 + 999.9999 = 13500.6249
    0.6249,
  ),
};

describe('decimal documents through generate, sign, QR and the strict XSD (HU-E5-09)', () => {
  let material: LoadedCertificate;
  beforeAll(() => {
    material = generateDevCertificate();
  });

  it.each(Object.keys(CASES))('%s', async (name) => {
    const built = await buildSignedInvoice(
      { builder: new TipsDeXmlBuilder(), signer: new TipsXmlSigner() },
      CASES[name],
      context('test'),
      material,
      { allowDecimals: true },
    );
    // addQrToSignedInvoice checks the final XML against the strict siRecepDE XSD.
    const withQr = await addQrToSignedInvoice(new TipsQrGenerator(), built.xml, {
      environment: 'test',
      idCsc: '0001',
      csc: 'ABCD0000000000000000000000000000',
    });

    const total = /<dTotGralOpe>([^<]*)<\/dTotGralOpe>/.exec(withQr)?.[1];
    expect(total).toBeDefined();
    expect(withQr).toContain(`dTotGralOpe=${String(total)}`);
    expect(withQr).not.toMatch(/<d\w+>-?[\d.]+e[+-]?\d+</i);
  });
});
