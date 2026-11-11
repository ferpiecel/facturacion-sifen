import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TipsDeXmlBuilder } from '@sifen/sifen-tips';
import { context } from '../../../../test/support/invoice-xml-fixture.js';
import type { DraftItem, InvoiceDraft } from '../domain/invoice-draft.js';
import { generateInvoiceXml } from './invoice-xml.js';

const receiver = {
  kind: 'named',
  isPublicEntity: false,
  address: { street: 'Avda Prueba', houseNumber: '100', cityCode: 3344 },
} as const;

const draft = (items: DraftItem[], roundingPyg = 0): InvoiceDraft => ({
  receiver,
  operationType: 'B2B',
  items,
  roundingPyg,
  location: { departmentCode: 11 },
});
const item = (quantity: number, unitPrice: number, vatRate: 0 | 5 | 10): DraftItem => ({
  quantity,
  unitPrice,
  vatRate,
});

/** Integer drafts: the XML generated before the decimal work must not change by a byte. */
const INTEGER_DRAFTS: Record<string, InvoiceDraft> = {
  'two lines 10% and 5%': draft([item(2, 5000, 10), item(1, 1050, 5)]),
  'rounding 37': draft([item(1, 107_437, 10)], 37),
  'exempt line': draft([item(3, 20_000, 0)]),
  'vat 10 with remainder': draft([item(7, 12_345, 10)], 15),
  'free item plus paid': draft([item(1, 0, 10), item(2, 55_000, 10)]),
  'large quantity': draft([item(1000, 999, 5)], 0),
};

/** `dFecFirma` is the wall clock at generation time, so it is pinned before hashing. */
const sha = (xml: string) =>
  createHash('sha256')
    .update(xml.replace(/<dFecFirma>[^<]*<\/dFecFirma>/, '<dFecFirma>PINNED</dFecFirma>'))
    .digest('hex');

/**
 * SHA-256 of the unsigned XML that `generateInvoiceXml` produced for each integer draft with the
 * code at origin/main 1907cd2 (before slice D), using the fixed fixture context in test mode and `dFecFirma` pinned.
 */
const GOLDEN_SHA256: Record<string, string> = {
  'two lines 10% and 5%': '7392107165b026a962c43b3eaeb0601f497a42e04fd62bb9f5babe0d052116ab',
  'rounding 37': 'b1698f2a155ab5a22a1839aac371cf29ab88b0f9258e9e2e44492d50b8ec1a75',
  'exempt line': '288a4f869632d5ef0b516ad7896d026c0c9a4d03fe87e24defad563409f7d504',
  'vat 10 with remainder': '54124fa1a30e3d5f265c378e4338945f95c918ec462f51b3354ad86dd2341157',
  'free item plus paid': '237e0c58c5344833d45775a0aee253cb85da01ff22e7fabc4e28664b7033ff10',
  'large quantity': '241221f756dcf73a3a4654b86d7dac6e9b33dc7f1b7aae4d7d3e39d68bf5e798',
};

describe('integer documents generate byte-identical XML (HU-E5-09 invariant)', () => {
  it.each(Object.keys(INTEGER_DRAFTS))('%s, decimals off', async (name) => {
    const { xml } = await generateInvoiceXml(
      new TipsDeXmlBuilder(),
      INTEGER_DRAFTS[name],
      context('test'),
    );
    expect(sha(xml)).toBe(GOLDEN_SHA256[name]);
  });

  it.each(Object.keys(INTEGER_DRAFTS))('%s, decimals on', async (name) => {
    const { xml } = await generateInvoiceXml(
      new TipsDeXmlBuilder(),
      INTEGER_DRAFTS[name],
      context('test'),
      { allowDecimals: true },
    );
    expect(sha(xml)).toBe(GOLDEN_SHA256[name]);
  });
});
