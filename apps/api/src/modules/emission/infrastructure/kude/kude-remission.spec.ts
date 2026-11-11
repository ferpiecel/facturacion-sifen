import { describe, expect, it } from 'vitest';
import { remissionNote, signedInvoiceWithQr } from '../../../../../test/support/signed-invoice.js';
import { readKudeInvoice } from '../../application/kude-reader.js';
import { decodeQr, pdfText } from './pdf-inspect.test-helper.js';
import { PdfkitKudeRenderer } from './pdfkit-kude-renderer.js';
import { PdfkitTicketKudeRenderer } from './pdfkit-ticket-kude-renderer.js';

const PRESENT = [
  'KuDE de Nota de Remisión Electrónica',
  'Nota de Remisión Electrónica',
  '001-001-0000001',
  'Receptor Prueba SA',
  'Traslado por ventas',
  'Camion Volvo ABC123',
  'Transportes SA',
  'Pedro Gomez',
  'Calle 1',
  'Calle 2',
  '120',
];
const ABSENT = [
  'KuDE de Factura Electrónica',
  'Condición de Venta',
  'Tipo de Operación',
  'SUBTOTAL',
  'TOTAL',
  'IVA',
  'Precio',
];

/** Spec: HU-E7-04. An NRE prints the trip, never prices or totals (it has none). */
describe('KuDE of a remission note', () => {
  it('prints the motive, the places, the vehicle and the carrier on A4, with a QR that decodes', async () => {
    const model = readKudeInvoice(await signedInvoiceWithQr(remissionNote));
    const pdf = await new PdfkitKudeRenderer().render(model);
    const text = await pdfText(pdf);

    for (const expected of PRESENT) expect(text).toContain(expected);
    for (const absent of ABSENT) expect(text).not.toContain(absent);
    expect(await decodeQr(pdf)).toBe(model.qrUrl);
  });

  it('prints the same data on a paper roll', async () => {
    const model = readKudeInvoice(await signedInvoiceWithQr(remissionNote));
    const text = await pdfText(await new PdfkitTicketKudeRenderer().render(model));

    for (const expected of PRESENT) expect(text).toContain(expected);
    for (const absent of ABSENT) expect(text).not.toContain(absent);
  });
});
