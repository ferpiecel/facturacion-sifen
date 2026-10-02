import { describe, expect, it } from 'vitest';
import type { KudeInvoice, KudeItem } from '../../domain/kude-model.js';
import { imageSizes, overlaps, pdfText, textItems } from './pdf-inspect.test-helper.js';
import { PdfkitKudeRenderer } from './pdfkit-kude-renderer.js';

const CDC = '01800695631001001000000612021112917595714694';
const QR_URL = `https://ekuatia.set.gov.py/consultas-test/qr?nVersion=150&Id=${CDC}&dFeEmiDE=313230&cHashQR=abc`;
const MM_25_PT = (25 / 25.4) * 72;

const item = (n: number): KudeItem => ({
  code: `INF${String(n).padStart(3, '0')}`,
  description: `Disco duro ${String(n)}`,
  unit: 'UNI',
  quantity: 1,
  unitPrice: 110000,
  discount: 0,
  vatRate: 10,
  total: 110000,
});

const invoice = (items: KudeItem[] = [item(12)]): KudeInvoice => ({
  environment: 'test',
  cdc: CDC,
  qrUrl: QR_URL,
  issuer: {
    name: 'Marta Anahi Bordon Vidal',
    tradeName: 'Soluciones Informáticas',
    activity: 'Reparación de Equipos Informáticos',
    address: 'Avenida González Vidal #1434',
    city: 'Asunción',
    ruc: '2365438-8',
  },
  stamp: { number: '1000332', validFrom: '2018-07-01', validTo: '2019-07-31' },
  establishment: '001',
  point: '001',
  documentNumber: '0000001',
  issuedAt: '2026-01-02T10:15:30',
  operationCondition: 'Contado',
  currency: 'PYG',
  receiver: {
    kind: 'named',
    document: '1131421-4',
    name: 'Belén Bosco',
    address: 'Mcal. López y Yegros',
    phone: '021 123 456',
    email: 'belbosco@gmail.com',
  },
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

describe('PdfkitKudeRenderer (FE, A4)', () => {
  const renderer = new PdfkitKudeRenderer();

  it('produces a PDF document', async () => {
    const pdf = await renderer.render(invoice());
    expect(Buffer.from(pdf).subarray(0, 5).toString()).toBe('%PDF-');
  });
  it('prints the title, emitter, stamp and document number (MT 13.4.1)', async () => {
    const text = await pdfText(await renderer.render(invoice()));
    for (const expected of [
      'KuDE de Factura Electrónica',
      'Marta Anahi Bordon Vidal',
      'Soluciones Informáticas',
      'Reparación de Equipos Informáticos',
      'Avenida González Vidal #1434',
      'RUC: 2365438-8',
      'Timbrado Nº 1000332',
      'Inicio de Vigencia: 01/07/2018',
      'Fin de Vigencia: 31/07/2019',
      'Factura Electrónica Nº 001-001-0000001',
    ]) {
      expect(text).toContain(expected);
    }
  });
  it('prints the general data and the receiver block', async () => {
    const text = await pdfText(await renderer.render(invoice()));
    for (const expected of [
      '2026-01-02T10:15:30',
      'Contado',
      'PYG',
      '1131421-4',
      'Belén Bosco',
      'Mcal. López y Yegros',
      '021 123 456',
      'belbosco@gmail.com',
      'Venta de mercadería',
    ]) {
      expect(text).toContain(expected);
    }
  });
  it('prints "Sin nombre" for an unnamed receiver', async () => {
    const unnamed = { ...invoice(), receiver: { kind: 'unnamed' as const } };
    expect(await pdfText(await renderer.render(unnamed))).toContain('Sin Nombre');
  });
  it('prints the items with the VAT column of each rate', async () => {
    const text = await pdfText(await renderer.render(invoice()));
    for (const expected of ['INF012', 'Disco duro 12', 'UNI', '110.000']) {
      expect(text).toContain(expected);
    }
    for (const heading of ['Exentas', '5%', '10%']) expect(text).toContain(heading);
  });
  it('embeds a QR image of at least 25 mm (MT 13.8.1)', async () => {
    const images = imageSizes(await renderer.render(invoice()));
    expect(images).toHaveLength(1);
    expect(images[0]?.w).toBeGreaterThanOrEqual(MM_25_PT);
    expect(images[0]?.h).toBeGreaterThanOrEqual(MM_25_PT);
  });
  it('is deterministic: same model, same bytes, fixed creation date', async () => {
    const first = Buffer.from(await renderer.render(invoice()));
    const second = Buffer.from(await renderer.render(invoice()));
    expect(first.equals(second)).toBe(true);
    // 2026-01-02 10:15:30 in Asunción (UTC-3 all year since 2024-10) = 13:15:30Z
    expect(first.toString('latin1')).toContain('(D:20260102131530Z)');
  });

  it('embeds a Unicode font: accents, guaraní and ₲ survive, unsupported glyphs become "?"', async () => {
    const named = { kind: 'named' as const, document: '1-1', name: 'Cafe\u0301 ₲ ĩ ẽ g\u0303 😀' };
    const text = await pdfText(await renderer.render({ ...invoice(), receiver: named }));
    expect(text).toContain('Café ₲ ĩ ẽ g\u0303 ?');
  });

  it('advances below wrapped text blocks and rows, never drawing text over text', async () => {
    const wordy = 'Sociedad Anónima de Responsabilidad Limitada del Paraguay '.repeat(3).trim();
    const base = invoice();
    const wrapped = {
      ...base,
      issuer: { ...base.issuer, name: wordy },
      receiver: { kind: 'named' as const, document: '1-1', name: wordy, address: wordy },
      items: [
        item(1),
        { ...item(2), code: 'CODIGO-LARGO-SIN-ESPACIOS-0002', unit: 'UNIDADLARGA' },
        item(3),
      ],
    };
    expect(overlaps(await textItems(await renderer.render(wrapped)))).toEqual([]);
  });

  it('never splits an amount or a heading across lines, even with 15-digit PYG', async () => {
    const big = 999_999_999_999_999;
    const row = { ...item(1), unitPrice: big, discount: big, total: big };
    const items = await textItems(await renderer.render(invoice([row])));
    expect(items.filter((i) => i.str === '999.999.999.999.999')).toHaveLength(3);
    expect(items.some((i) => i.str === 'Descuento')).toBe(true);
    expect(overlaps(items)).toEqual([]);
  });
});
