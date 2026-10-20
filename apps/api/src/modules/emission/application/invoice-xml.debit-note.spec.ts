import { describe, expect, it } from 'vitest';
import { TipsDeXmlBuilder } from '@sifen/sifen-tips';
import { context } from '../../../../test/support/invoice-xml-fixture.js';
import type { InvoiceDraft } from '../domain/invoice-draft.js';
import { generateInvoiceXml, InvoiceXmlError, mapInvoiceToXmlInput } from './invoice-xml.js';

const FE_CDC = '01800000013001001000000112026093010000000019';

const draft: InvoiceDraft = {
  receiver: {
    kind: 'named',
    isPublicEntity: false,
    address: { street: 'Avda Prueba', houseNumber: '100', cityCode: 3344 },
  },
  operationType: 'B2B',
  items: [{ quantity: 1, unitPrice: 55_000, vatRate: 10 }],
  roundingPyg: 0,
  location: { departmentCode: 11 },
};
const debitNote = { associatedCdc: FE_CDC, reasonCode: 3 };
const ctx = () => ({ ...context('test'), debitNote, lines: [context('test').lines[0]] });

/** Spec: HU-E7-02. The NDE (iTiDE 6) built by xmlgen, checked against the XSD. */
describe('debit note XML', () => {
  it('maps type 6 with the reason and the association, without the FE-only groups', () => {
    const { data } = mapInvoiceToXmlInput(draft, ctx());
    expect(data).toMatchObject({
      tipoDocumento: 6,
      notaCreditoDebito: { motivo: 3 },
      documentoAsociado: { formato: 1, cdc: FE_CDC },
    });
    expect(data).not.toHaveProperty('factura');
    expect(data).not.toHaveProperty('condicion');
  });

  it('builds an XML that passes the siRecepDE XSD, with a 06 CDC and the note groups', async () => {
    const { xml, cdc } = await generateInvoiceXml(new TipsDeXmlBuilder(), draft, ctx());
    expect(cdc).toMatch(/^06/);
    expect(xml).toMatch(/<iTiDE>6<\/iTiDE>/);
    expect(xml).toMatch(/<gCamNCDE><iMotEmi>3<\/iMotEmi>/);
    expect(xml).toContain(`<dCdCDERef>${FE_CDC}</dCdCDERef>`);
    for (const absent of ['<gCamCond>', '<gCamFE>', '<iTipTra>', '<gTransp>']) {
      expect(xml).not.toContain(absent);
    }
  });

  it('refuses a reason outside the table and an unnamed receiver (1331)', async () => {
    await expect(
      generateInvoiceXml(new TipsDeXmlBuilder(), draft, {
        ...ctx(),
        debitNote: { ...debitNote, reasonCode: 9 },
      }),
    ).rejects.toBeInstanceOf(InvoiceXmlError);
    await expect(
      generateInvoiceXml(
        new TipsDeXmlBuilder(),
        { ...draft, receiver: { kind: 'unnamed' }, operationType: 'B2C', location: {} },
        ctx(),
      ),
    ).rejects.toThrow(/1331/);
  });
});
