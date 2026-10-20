import { describe, expect, it } from 'vitest';
import type { FacturaPocInput } from '@sifen/sifen-gateway';
import { signedInvoiceWithQr } from '../../../../../test/support/signed-invoice.js';
import { readKudeInvoice } from '../../application/kude-reader.js';
import type { KudeInvoice, KudeItem } from '../../domain/kude-model.js';
import {
  decodeQr,
  imageSizes,
  overlaps,
  pageSizes,
  pdfText,
  textItems,
} from './pdf-inspect.test-helper.js';
import { createKudeRenderer } from './kude-renderer.js';
import { PdfkitTicketKudeRenderer } from './pdfkit-ticket-kude-renderer.js';

const CDC = '01800695631001001000000612021112917595714694';
const QR_URL = `https://ekuatia.set.gov.py/consultas-test/qr?nVersion=150&Id=${CDC}&dFeEmiDE=313230&cHashQR=abc`;
const MM = 72 / 25.4;

const item = (n: number, description = `Hamburguesa doble ${String(n)}`): KudeItem => ({
  code: `PLT${String(n).padStart(3, '0')}`,
  description,
  unit: 'UNI',
  quantity: 2,
  unitPrice: 55000,
  discount: 0,
  vatRate: 10,
  total: 110000,
});

const invoice = (items: KudeItem[] = [item(1)]): KudeInvoice => ({
  environment: 'test',
  cdc: CDC,
  qrUrl: QR_URL,
  issuer: {
    name: 'Restaurante La Parrilla SA',
    tradeName: 'La Parrilla',
    activity: 'Servicio de comidas y bebidas',
    address: 'Avenida Mariscal López 1234',
    city: 'Asunción',
    ruc: '80069563-1',
  },
  stamp: { number: '1000332', validFrom: '2018-07-01', validTo: '2019-07-31' },
  establishment: '001',
  point: '001',
  documentNumber: '0000001',
  issuedAt: '2026-01-02T10:15:30',
  operationCondition: 'Contado',
  currency: 'PYG',
  receiver: { kind: 'unnamed' },
  transactionType: 'Venta de mercadería',
  items,
  totals: {
    subtotalExempt: 0,
    subtotal5: 0,
    subtotal10: items.length * 110000,
    totalOperation: items.length * 110000,
    totalGs: items.length * 110000,
    vat5: 0,
    vat10: items.length * 10000,
    totalVat: items.length * 10000,
  },
});

describe.each([
  ['ticket-80', 80],
  ['ticket-58', 58],
] as const)('PdfkitTicketKudeRenderer (%s)', (format, widthMm) => {
  const renderer = new PdfkitTicketKudeRenderer();
  const render = (model = invoice()) => renderer.render(model, format);

  it('is one PDF page exactly as wide as the paper roll (MT 13.6)', async () => {
    const pdf = await render();
    expect(Buffer.from(pdf).subarray(0, 5).toString()).toBe('%PDF-');
    const sizes = await pageSizes(pdf);
    expect(sizes).toHaveLength(1);
    expect(sizes[0]?.w).toBeCloseTo(widthMm * MM, 1);
  });

  it('prints the header, items, totals, legend and CDC groups (MT 13.4)', async () => {
    const text = await pdfText(await render(invoice([item(1), item(2)])));
    for (const expected of [
      'KuDE de Factura Electrónica',
      'Restaurante La Parrilla SA',
      'RUC: 80069563-1',
      'Timbrado Nº 1000332',
      'Nº 001-001-0000001',
      '2026-01-02T10:15:30',
      'Sin Nombre',
      'Hamburguesa doble 2',
      '55.000',
      'TOTAL DE LA OPERACIÓN',
      '220.000',
      'TOTAL IVA',
      'https://ekuatia.set.gov.py/consultas-test/',
    ]) {
      expect(text).toContain(expected);
    }
    expect(text.replace(/\s/g, '')).toContain(CDC);
  });

  it('embeds a QR of at least 25 mm that decodes to the signed dCarQR URL (MT 13.8.1)', async () => {
    const pdf = await render();
    expect(await decodeQr(pdf)).toBe(QR_URL);
    expect(imageSizes(pdf)[0]?.w).toBeGreaterThanOrEqual(25 * MM - 0.5);
  });

  it('keeps every string inside the paper and never overlaps two strings', async () => {
    const long = item(3, 'Parrillada completa para compartir con papas fritas y ensalada mixta');
    const pdf = await render(invoice([item(1), long]));
    const items = await textItems(pdf);
    const width = (await pageSizes(pdf))[0]?.w ?? 0;
    for (const text of items) expect(text.x + text.width).toBeLessThanOrEqual(width + 0.5);
    expect(overlaps(items)).toEqual([]);
  });

  it('grows the page with the items instead of paginating', async () => {
    const few = await pageSizes(await render());
    const many = await pageSizes(
      await render(invoice(Array.from({ length: 60 }, (_, i) => item(i)))),
    );
    expect(many).toHaveLength(1);
    expect(many[0]?.h).toBeGreaterThan(few[0]?.h ?? Infinity);
  });

  it('shows the per-item discount only when there is one', async () => {
    expect(await pdfText(await render())).not.toContain('Desc.');
    expect(await pdfText(await render(invoice([{ ...item(1), discount: 5000 }])))).toContain(
      'Desc.',
    );
  });

  it('is deterministic and refuses a model that cannot be drawn', async () => {
    expect(Buffer.from(await render()).equals(Buffer.from(await render()))).toBe(true);
    await expect(render({ ...invoice(), cdc: '123' })).rejects.toThrow(/cdc/);
  });

  it('prints the named receiver block', async () => {
    const receiver = { kind: 'named', document: '1131421-4', name: 'Belén Bosco', email: 'b@x.py' };
    const text = await pdfText(await render({ ...invoice(), receiver } as KudeInvoice));
    for (const expected of ['1131421-4', 'Belén Bosco', 'b@x.py']) expect(text).toContain(expected);
  });
});

describe('PdfkitTicketKudeRenderer, credit note', () => {
  const FE_CDC = '01800695631001002000012312026010111234567891';

  it('prints the NCE title, reason and associated invoice', async () => {
    const xml = await signedInvoiceWithQr((input: FacturaPocInput) => ({
      ...input,
      data: {
        ...Object.fromEntries(
          Object.entries(input.data).filter(([key]) => key !== 'factura' && key !== 'condicion'),
        ),
        tipoDocumento: 5,
        notaCreditoDebito: { motivo: 2 },
        documentoAsociado: { formato: 1, cdc: FE_CDC },
      },
    }));
    const text = await pdfText(
      await new PdfkitTicketKudeRenderer().render(readKudeInvoice(xml), 'ticket-58'),
    );
    for (const expected of [
      'KuDE de Nota de Crédito Electrónica',
      'Devolución',
      '001-002-0000123',
    ]) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain('KuDE de Factura Electrónica');
  });
});

describe('PdfkitTicketKudeRenderer, debit note', () => {
  it('prints the NDE title, reason and associated invoice', async () => {
    const FE_CDC = '01800695631001002000012312026010111234567891';
    const xml = await signedInvoiceWithQr((input: FacturaPocInput) => ({
      ...input,
      data: {
        ...Object.fromEntries(
          Object.entries(input.data).filter(([key]) => key !== 'factura' && key !== 'condicion'),
        ),
        tipoDocumento: 6,
        notaCreditoDebito: { motivo: 2 },
        documentoAsociado: { formato: 1, cdc: FE_CDC },
      },
    }));
    const text = await pdfText(
      await new PdfkitTicketKudeRenderer().render(readKudeInvoice(xml), 'ticket-58'),
    );
    for (const expected of [
      'KuDE de Nota de Débito Electrónica',
      'Devolución',
      '001-002-0000123',
    ]) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain('Crédito');
  });
});

describe('createKudeRenderer', () => {
  it('uses the letter layout by default and the ticket layout on request', async () => {
    const renderer = createKudeRenderer();
    const width = async (format?: 'letter' | 'ticket-80') =>
      (await pageSizes(await renderer.render(invoice(), format))).map((page) => page.w)[0];
    expect(await width()).toBeCloseTo(595.28, 0);
    expect(await width('letter')).toBeCloseTo(595.28, 0);
    expect(await width('ticket-80')).toBeCloseTo(80 * MM, 1);
  });
});
