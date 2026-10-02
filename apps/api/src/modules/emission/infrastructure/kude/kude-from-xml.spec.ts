import { describe, expect, it } from 'vitest';
import { signedInvoiceWithQr } from '../../../../../test/support/signed-invoice.js';
import { readKudeInvoice } from '../../application/kude-reader.js';
import { decodeQr, imageSizes, pdfText } from './pdf-inspect.test-helper.js';
import { PdfkitKudeRenderer } from './pdfkit-kude-renderer.js';

describe('KuDE from the real pipeline (build -> sign -> QR -> read -> render)', () => {
  it('prints the signed document and a QR that decodes to its dCarQR', async () => {
    const xml = await signedInvoiceWithQr();
    const model = readKudeInvoice(xml);
    const pdf = await new PdfkitKudeRenderer().render(model);
    const text = await pdfText(pdf);

    for (const expected of [
      'KuDE de Factura Electrónica',
      'RUC: 80000001-9',
      'Timbrado Nº 12345678',
      'Factura Electrónica Nº 001-001-0000001',
      'Receptor Prueba SA',
      'A-001',
      'TOTAL IVA: 909',
      'TOTAL EN GUARANÍES: 10.000',
    ]) {
      expect(text).toContain(expected);
    }
    expect(text).toContain(model.cdc.match(/\d{4}/g)?.join(' '));
    expect(text).not.toContain('Fin de Vigencia');
    expect(await decodeQr(pdf)).toBe(model.qrUrl);
    expect(imageSizes(pdf)[0]?.w).toBeGreaterThanOrEqual((25 / 25.4) * 72);
  });

  it('prints the stamp end date when the caller provides it', async () => {
    const model = readKudeInvoice(await signedInvoiceWithQr(), { stampValidTo: '2030-12-31' });
    const text = await pdfText(await new PdfkitKudeRenderer().render(model));
    expect(text).toContain('Fin de Vigencia: 31/12/2030');
  });
});
