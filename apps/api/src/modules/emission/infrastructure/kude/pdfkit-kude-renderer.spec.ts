import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { KudeInvoice, KudeItem } from '../../domain/kude-model.js';
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

/** Inflates every stream of the PDF; plain (uncompressed) streams pass through. */
function streams(pdf: Uint8Array): string[] {
  const raw = Buffer.from(pdf).toString('latin1');
  return [...raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].map((m) => {
    const bytes = Buffer.from(m[1], 'latin1');
    try {
      return inflateSync(bytes).toString('latin1');
    } catch {
      return bytes.toString('latin1');
    }
  });
}

/** Text shown by the content streams: standard-font strings are WinAnsi hex in Tj/TJ operators. */
function pdfText(pdf: Uint8Array): string {
  const lines: string[] = [];
  for (const content of streams(pdf)) {
    for (const op of content.matchAll(/(\[[^\]]*\]|<[0-9a-fA-F]*>)\s*TJ?/g)) {
      const hex = [...op[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => h[1]);
      lines.push(Buffer.from(hex.join(''), 'hex').toString('latin1'));
    }
  }
  return lines.join('\n');
}

/** Width and height in points of every image painted on the pages. */
function imageSizes(pdf: Uint8Array): { w: number; h: number }[] {
  return streams(pdf).flatMap((content) =>
    [...content.matchAll(/(-?[\d.]+) 0 0 (-?[\d.]+) -?[\d.]+ -?[\d.]+ cm\s+\/I\d+ Do/g)].map(
      (m) => ({ w: Math.abs(Number(m[1])), h: Math.abs(Number(m[2])) }),
    ),
  );
}

describe('PdfkitKudeRenderer (FE, A4)', () => {
  const renderer = new PdfkitKudeRenderer();

  it('produces a PDF document', async () => {
    const pdf = await renderer.render(invoice());
    expect(Buffer.from(pdf).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('prints the title, emitter, stamp and document number (MT 13.4.1)', async () => {
    const text = pdfText(await renderer.render(invoice()));
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
    const text = pdfText(await renderer.render(invoice()));
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
    expect(pdfText(await renderer.render(unnamed))).toContain('Sin Nombre');
  });

  it('prints the items with the VAT column of each rate', async () => {
    const text = pdfText(await renderer.render(invoice()));
    for (const expected of ['INF012', 'Disco duro 12', 'UNI', '110.000']) {
      expect(text).toContain(expected);
    }
    for (const heading of ['Exentas', '5%', '10%']) expect(text).toContain(heading);
  });

  it('prints subtotals, totals and the VAT breakdown (MT 13.4.3)', async () => {
    const text = pdfText(await renderer.render(invoice()));
    for (const expected of [
      'SUBTOTAL',
      'TOTAL DE LA OPERACIÓN: 110.000',
      'TOTAL EN GUARANÍES: 110.000',
      'LIQUIDACIÓN IVA: (5%) 0 (10%) 10.000',
      'TOTAL IVA: 10.000',
    ]) {
      expect(text).toContain(expected);
    }
  });

  it('prints the CDC in eleven groups of four and the consultation legend (MT 13.4.4)', async () => {
    const text = pdfText(await renderer.render(invoice()));
    expect(text).toContain('0180 0695 6310 0100 1000 0006 1202 1112 9175 9571 4694');
    expect(text).toContain(
      'Consulte la validez de esta Factura Electrónica con el número de CDC impreso abajo en:',
    );
    expect(text).toContain('https://ekuatia.set.gov.py/consultas-test');
  });

  it('points the legend to the production URL in production', async () => {
    const text = pdfText(await renderer.render({ ...invoice(), environment: 'production' }));
    expect(text).toContain('https://ekuatia.set.gov.py/consultas\n');
    expect(text).not.toContain('consultas-test');
  });

  it('embeds a QR image of at least 25 mm (MT 13.8.1)', async () => {
    const images = imageSizes(await renderer.render(invoice()));
    expect(images).toHaveLength(1);
    expect(images[0]?.w).toBeGreaterThanOrEqual(MM_25_PT);
    expect(images[0]?.h).toBeGreaterThanOrEqual(MM_25_PT);
  });

  it('numbers the pages "n/total" and keeps the totals on the last page (MT 13.3)', async () => {
    const pdf = await renderer.render(invoice(Array.from({ length: 70 }, (_, i) => item(i + 1))));
    const text = pdfText(pdf);
    expect(text).toContain('Página 1/2');
    expect(text).toContain('Página 2/2');
    expect(text).toContain('INF070');
    expect(text.match(/TOTAL IVA/g)).toHaveLength(1);
    expect(imageSizes(pdf)).toHaveLength(1);
  });

  it('is deterministic: same model, same bytes, fixed creation date', async () => {
    const first = Buffer.from(await renderer.render(invoice()));
    const second = Buffer.from(await renderer.render(invoice()));
    expect(first.equals(second)).toBe(true);
    // 2026-01-02 10:15:30 in Asunción (UTC-3 all year since 2024-10) = 13:15:30Z
    expect(first.toString('latin1')).toContain('(D:20260102131530Z)');
  });
});
