import { describe, expect, it } from 'vitest';
import { TipsDeXmlBuilder } from '@sifen/sifen-tips';
import { context } from '../../../../test/support/invoice-xml-fixture.js';
import type { InvoiceDraft } from '../domain/invoice-draft.js';
import { generateInvoiceXml, InvoiceXmlError, mapInvoiceToXmlInput } from './invoice-xml.js';

const FE_CDC = '01800000013001001000000112026093010000000019';

/** The FE's receiver, operation and location, with the credit note's own items. */
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
const creditNote = { associatedCdc: FE_CDC, reasonCode: 2 };
const ctx = () => ({ ...context('test'), creditNote, lines: [context('test').lines[0]] });

/** Spec: HU-E7-01 T7 (ADR-0019 D8, D9). The NCE (iTiDE 5) built by xmlgen, checked against the XSD. */
describe('credit note XML', () => {
  it('maps type 5 with the reason and the association, without the FE-only groups', () => {
    const { data } = mapInvoiceToXmlInput(draft, ctx());
    expect(data).toMatchObject({
      tipoDocumento: 5,
      notaCreditoDebito: { motivo: 2 },
      documentoAsociado: { formato: 1, cdc: FE_CDC },
    });
    expect(data).not.toHaveProperty('factura');
    expect(data).not.toHaveProperty('condicion');
  });

  it('keeps an FE untouched: type 1, factura and condicion, no association', () => {
    const { data } = mapInvoiceToXmlInput(draft, {
      ...context('test'),
      lines: [context('test').lines[0]],
    });
    expect(data).toMatchObject({ tipoDocumento: 1, factura: { presencia: 1 } });
    expect(data).toHaveProperty('condicion');
    expect(data).not.toHaveProperty('notaCreditoDebito');
    expect(data).not.toHaveProperty('documentoAsociado');
  });

  it('builds an XML that passes the siRecepDE XSD, with a 05 CDC and the credit note groups', async () => {
    const { xml, cdc } = await generateInvoiceXml(new TipsDeXmlBuilder(), draft, ctx());

    expect(cdc).toMatch(/^05/);
    expect(xml).toContain(`<DE Id="${cdc}"`);
    expect(xml).toMatch(/<iTiDE>5<\/iTiDE>/);
    expect(xml).toMatch(
      /<gCamNCDE><iMotEmi>2<\/iMotEmi><dDesMotEmi>Devolución<\/dDesMotEmi><\/gCamNCDE>/,
    );
    expect(xml).toContain(
      `<gCamDEAsoc><iTipDocAso>1</iTipDocAso><dDesTipDocAso>Electrónico</dDesTipDocAso><dCdCDERef>${FE_CDC}</dCdCDERef></gCamDEAsoc>`,
    );
    for (const absent of ['<gCamCond>', '<gCamFE>', '<iTipTra>', '<gTransp>']) {
      expect(xml).not.toContain(absent);
    }
  });

  it('writes the receiver of the FE and the shared totals', async () => {
    const { xml } = await generateInvoiceXml(new TipsDeXmlBuilder(), draft, ctx());
    expect(xml).toContain('<dNomRec>Receptor Prueba SA</dNomRec>');
    expect(xml).toContain('<dTotGralOpe>55000</dTotGralOpe>');
  });

  it('refuses a reason outside the table instead of sending it', async () => {
    await expect(
      generateInvoiceXml(new TipsDeXmlBuilder(), draft, {
        ...ctx(),
        creditNote: { ...creditNote, reasonCode: 9 },
      }),
    ).rejects.toBeInstanceOf(InvoiceXmlError);
  });
});
