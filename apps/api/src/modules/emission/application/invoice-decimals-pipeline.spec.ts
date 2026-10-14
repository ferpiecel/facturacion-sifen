import { beforeAll, describe, expect, it } from 'vitest';
import { Decimal } from '../domain/decimal.js';
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

/** Exact value of the first `<tag>` of the XML (0 when absent). */
function amount(xml: string, tag: string): Decimal {
  const text = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1] ?? '0';
  const parsed = Decimal.parse(text);
  if (!parsed.ok) throw new Error(`${tag} is not a plain decimal: ${text}`);
  return parsed.value;
}

/** Per VAT rate, the sums of the per-item fields the F-group totals must equal. */
function itemSums(xml: string, rate: 5 | 10) {
  const zero = Decimal.zero();
  const sums = { total: zero, base: zero, vat: zero };
  for (const item of xml.match(/<gCamItem>[\s\S]*?<\/gCamItem>/g) ?? []) {
    if (!item.includes(`<dTasaIVA>${String(rate)}</dTasaIVA>`)) continue;
    sums.total = sums.total.add(amount(item, 'dTotOpeItem'));
    sums.base = sums.base.add(amount(item, 'dBasGravIVA'));
    sums.vat = sums.vat.add(amount(item, 'dLiqIVAItem'));
  }
  return sums;
}

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

    // The XSD does not check the F-group arithmetic (MT v150 validations 212-235): do it here.
    const eq = (a: Decimal, b: Decimal) => {
      expect(a.toString()).toBe(b.toString());
    };
    eq(amount(withQr, 'dTotOpe').subtract(amount(withQr, 'dRedon')), amount(withQr, 'dTotGralOpe'));
    eq(
      amount(withQr, 'dSubExe')
        .add(amount(withQr, 'dSubExo'))
        .add(amount(withQr, 'dSub5'))
        .add(amount(withQr, 'dSub10')),
      amount(withQr, 'dTotOpe'),
    );
    eq(amount(withQr, 'dSub5'), itemSums(withQr, 5).total);
    eq(amount(withQr, 'dSub10'), itemSums(withQr, 10).total);
    // Documents on the decimal xmlgen options keep 8 decimals, so the sums are exact. Whole-peso
    // totals keep xmlgen's default (sums rounded to integers, ADR-0018 provisional, T1): within 1.
    const exactSums =
      amount(withQr, 'dTotOpe').decimalPlaces() > 0 || amount(withQr, 'dRedon').decimalPlaces() > 0;
    const one = amount('<x>1</x>', 'x');
    const sums = (actual: Decimal, expected: Decimal) => {
      if (exactSums) {
        eq(actual, expected);
        return;
      }
      const gap = actual.subtract(expected);
      expect(gap.compare(one)).toBeLessThan(0);
      expect(gap.compare(one.negate())).toBeGreaterThan(0);
    };
    sums(amount(withQr, 'dIVA5'), itemSums(withQr, 5).vat);
    sums(amount(withQr, 'dIVA10'), itemSums(withQr, 10).vat);
    sums(amount(withQr, 'dBaseGrav5'), itemSums(withQr, 5).base);
    sums(amount(withQr, 'dBaseGrav10'), itemSums(withQr, 10).base);
    eq(amount(withQr, 'dTotIVA'), amount(withQr, 'dIVA5').add(amount(withQr, 'dIVA10')));
    eq(
      amount(withQr, 'dTBasGraIVA'),
      amount(withQr, 'dBaseGrav5').add(amount(withQr, 'dBaseGrav10')),
    );
  });
});
