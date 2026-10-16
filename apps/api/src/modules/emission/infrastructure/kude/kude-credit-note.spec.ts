import { describe, expect, it } from 'vitest';
import type { FacturaPocInput } from '@sifen/sifen-gateway';
import { signedInvoiceWithQr } from '../../../../../test/support/signed-invoice.js';
import { KudeSourceError, readKudeInvoice } from '../../application/kude-reader.js';
import { decodeQr, pdfText } from './pdf-inspect.test-helper.js';
import { PdfkitKudeRenderer } from './pdfkit-kude-renderer.js';

/** The FE the NCE credits: est 001, point 002, number 0000123. */
const FE_CDC = '01800695631001002000012312026010111234567891';

/** The real NCE pipeline output (xmlgen type 5, as `credit-note-signing.spec.ts` builds it). */
const creditNote = (reasonCode = 2) =>
  signedInvoiceWithQr((input: FacturaPocInput) => ({
    ...input,
    data: {
      ...Object.fromEntries(
        Object.entries(input.data).filter(([key]) => key !== 'factura' && key !== 'condicion'),
      ),
      tipoDocumento: 5,
      notaCreditoDebito: { motivo: reasonCode },
      documentoAsociado: { formato: 1, cdc: FE_CDC },
    },
  }));

/** Spec: HU-E7-01 T8. MT v150 13.3 title; layout per Gráfica N° 10 is referential (see the plan, T0). */
describe('KuDE of a credit note', () => {
  it('reads the reason and the associated invoice, with no condition or transaction type', async () => {
    const model = readKudeInvoice(await creditNote(3));
    expect(model.creditNote).toEqual({ reason: 'Descuento', associatedCdc: FE_CDC });
    expect(model.operationCondition).toBeUndefined();
    expect(model.transactionType).toBeUndefined();
    expect(model.totals.totalOperation).toBe(10000);
  });

  it('prints the NCE title, number, reason and associated invoice, and a QR that decodes', async () => {
    const model = readKudeInvoice(await creditNote(2));
    const pdf = await new PdfkitKudeRenderer().render(model);
    const text = await pdfText(pdf);

    for (const expected of [
      'KuDE de Nota de Crédito Electrónica',
      // The longer label wraps inside the stamp box: label and number are separate lines.
      'Nota de Crédito Electrónica Nº',
      '001-001-0000001',
      'Motivo de Emisión: Devolución',
      'Documento Asociado: Factura Electrónica Nº 001-002-0000123',
      FE_CDC.match(/\d{4}/g)?.join(' '),
      'Receptor Prueba SA',
      'TOTAL EN GUARANÍES: 10.000',
    ]) {
      expect(text).toContain(expected);
    }
    for (const absent of [
      'KuDE de Factura Electrónica',
      'Condición de Venta',
      'Tipo de Operación',
    ]) {
      expect(text).not.toContain(absent);
    }
    expect(await decodeQr(pdf)).toBe(model.qrUrl);
  });

  it('refuses a credit note without its association, naming the field', async () => {
    const xml = (await creditNote()).replace(/<dCdCDERef>[^<]*<\/dCdCDERef>/, '');
    expect(() => readKudeInvoice(xml)).toThrow(KudeSourceError);
  });

  it.each(['123', 'a'.repeat(44)])(
    'refuses a malformed associated CDC (%s) with a KudeSourceError, not a plain Error',
    async (bad) => {
      const xml = (await creditNote()).replace(
        /<dCdCDERef>[^<]*<\/dCdCDERef>/,
        `<dCdCDERef>${bad}</dCdCDERef>`,
      );
      expect(() => readKudeInvoice(xml)).toThrow(KudeSourceError);
    },
  );

  it('still refuses the types that have no layout (an NDE)', async () => {
    const xml = (await creditNote()).replace('<iTiDE>5</iTiDE>', '<iTiDE>6</iTiDE>');
    expect(() => readKudeInvoice(xml)).toThrow(/unsupported/);
  });
});
