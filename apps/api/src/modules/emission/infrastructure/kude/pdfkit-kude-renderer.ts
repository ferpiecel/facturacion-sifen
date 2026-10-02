import { readFileSync } from 'node:fs';
import { create as openFont } from 'fontkit';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import type { KudeRenderer } from '../../application/ports/kude-renderer.port.js';
import { fromAsuncionTimestamp } from '../../application/invoice-xml.js';
import {
  assertValidKudeInvoice,
  formatDateDmy,
  formatDocumentNumber,
  formatPyg,
  formatQuantity,
  groupCdc,
  KUDE_CONSULT_URL,
  KUDE_TITLE,
  type KudeInvoice,
  type KudeItem,
} from '../../domain/kude-model.js';

const PT_PER_MM = 72 / 25.4;
/** MT v150 13.8.1: printed QR at least 25 mm wide, 22 mm of content plus the quiet zone. */
const QR_CONTENT_MM = 24;
/** Quiet zone per side, as a share of the QR content (about 12% of the printed width). */
const QR_QUIET_SHARE = 0.16;
const MARGIN = 36;
const BOTTOM = 60;
const FOOTER_BLOCK = 190;

/** Noto Sans (SIL OFL 1.1, apps/api/assets/fonts): Latin, Guaraní tildes and the guaraní sign U+20B2. */
const FONT_DIR = new URL('../../../../../assets/fonts/', import.meta.url);

interface Fonts {
  regular: Buffer;
  bold: Buffer;
  covers: (codePoint: number) => boolean;
}

let loaded: Fonts | undefined;
function fonts(): Fonts {
  if (loaded) return loaded;
  const regular = readFileSync(new URL('NotoSans-Regular.ttf', FONT_DIR));
  const bold = readFileSync(new URL('NotoSans-Bold.ttf', FONT_DIR));
  const [r, b] = [openFont(regular), openFont(bold)] as const;
  const covers = (cp: number) =>
    'hasGlyphForCodePoint' in r &&
    'hasGlyphForCodePoint' in b &&
    r.hasGlyphForCodePoint(cp) &&
    b.hasGlyphForCodePoint(cp);
  loaded = { regular, bold, covers };
  return loaded;
}

/** NFC, whitespace controls to spaces, and "?" for every code point the font cannot draw. */
function sanitize(text: string): string {
  const { covers } = fonts();
  return Array.from(text.normalize('NFC').replace(/[\r\n\t]/g, ' '))
    .map((char) => (covers(char.codePointAt(0) ?? 0) ? char : '?'))
    .join('');
}

const COLUMNS = [
  { key: 'code', title: 'Cód.', width: 42, align: 'left', wrap: true },
  { key: 'description', title: 'Descripción', width: 130, align: 'left', wrap: true },
  { key: 'unit', title: 'Unidad', width: 32, align: 'left', wrap: true },
  { key: 'quantity', title: 'Cant.', width: 40, align: 'right', wrap: false },
  { key: 'unitPrice', title: 'Precio Unit.', width: 60, align: 'right', wrap: false },
  { key: 'discount', title: 'Descuento', width: 48, align: 'right', wrap: false },
  { key: 'exempt', title: 'Exentas', width: 55, align: 'right', wrap: false },
  { key: 'vat5', title: '5%', width: 55, align: 'right', wrap: false },
  { key: 'vat10', title: '10%', width: 61, align: 'right', wrap: false },
] as const;

type Doc = InstanceType<typeof PDFDocument>;

function cells(item: KudeItem): Record<(typeof COLUMNS)[number]['key'], string> {
  const at = (rate: 0 | 5 | 10) => (item.vatRate === rate ? formatPyg(item.total) : '0');
  return {
    code: item.code,
    description: item.description,
    unit: item.unit,
    quantity: formatQuantity(item.quantity),
    unitPrice: formatPyg(item.unitPrice),
    discount: formatPyg(item.discount),
    exempt: at(0),
    vat5: at(5),
    vat10: at(10),
  };
}

/** KuDE of an FE on A4 (MT v150 chapter 13, "Formato 1"), drawn with embedded Noto Sans. */
export class PdfkitKudeRenderer implements KudeRenderer {
  async render(invoice: KudeInvoice): Promise<Uint8Array> {
    assertValidKudeInvoice(invoice);
    const modules = QRCode.create(invoice.qrUrl, { errorCorrectionLevel: 'M' }).modules.size;
    const quiet = Math.ceil(modules * QR_QUIET_SHARE);
    const qr = {
      png: await QRCode.toBuffer(invoice.qrUrl, {
        type: 'png',
        errorCorrectionLevel: 'M',
        margin: quiet,
        scale: 4,
      }),
      size: ((QR_CONTENT_MM * (modules + 2 * quiet)) / modules) * PT_PER_MM,
    };
    const created = fromAsuncionTimestamp(invoice.issuedAt);
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      bufferPages: true,
      info: {
        Title: `${KUDE_TITLE} ${formatDocumentNumber(invoice.establishment, invoice.point, invoice.documentNumber)}`,
        Creator: 'facturacion-sifen',
        Producer: 'facturacion-sifen',
        CreationDate: created,
        ModDate: created,
      },
    });
    doc.registerFont('regular', fonts().regular);
    doc.registerFont('bold', fonts().bold);
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    const done = new Promise<Uint8Array>((resolve) => {
      doc.on('end', () => {
        resolve(new Uint8Array(Buffer.concat(chunks)));
      });
    });

    const y = this.general(doc, invoice, this.header(doc, invoice, qr) + 12);
    this.totals(doc, invoice, this.items(doc, invoice.items, y));
    this.pageNumbers(doc);
    doc.end();
    return done;
  }

  /** One unwrapped line; shrinks the font until it fits `width` (amounts must never split). */
  private line(
    doc: Doc,
    raw: string,
    x: number,
    y: number,
    options: { width?: number; align?: 'left' | 'right' | 'center'; bold?: boolean; size?: number },
  ): void {
    const text = sanitize(raw);
    const base = options.size ?? 8;
    doc.font(options.bold ? 'bold' : 'regular').fontSize(base);
    const natural = doc.widthOfString(text);
    const size =
      options.width !== undefined && natural > options.width
        ? (base * options.width) / natural
        : base;
    doc
      .fontSize(size)
      .text(text, x, y, { width: options.width, align: options.align, lineBreak: false });
  }

  /** A wrapped block; returns the y where the next block starts. */
  private put(
    doc: Doc,
    raw: string,
    x: number,
    y: number,
    options: { width: number; bold?: boolean; size?: number },
  ): number {
    const text = sanitize(raw);
    doc.font(options.bold ? 'bold' : 'regular').fontSize(options.size ?? 8);
    doc.text(text, x, y, { width: options.width });
    return y + doc.heightOfString(text, { width: options.width }) + 2;
  }

  /** Draws the header and returns the y below its lowest block. */
  private header(doc: Doc, invoice: KudeInvoice, qr: { png: Buffer; size: number }): number {
    const { issuer, stamp } = invoice;
    this.line(doc, KUDE_TITLE, MARGIN, MARGIN, {
      width: doc.page.width - 2 * MARGIN,
      align: 'center',
      bold: true,
      size: 14,
    });
    const top = 64;
    let left = this.put(doc, issuer.name, MARGIN, top, { bold: true, size: 10, width: 235 });
    for (const text of [
      issuer.tradeName,
      issuer.activity,
      issuer.address,
      `Ciudad: ${issuer.city}`,
    ]) {
      if (text) left = this.put(doc, text, MARGIN, left, { width: 235 });
    }
    const documentNumber = formatDocumentNumber(
      invoice.establishment,
      invoice.point,
      invoice.documentNumber,
    );
    const stampLines = [
      `RUC: ${issuer.ruc}`,
      `Timbrado Nº ${stamp.number}`,
      `Fecha de Inicio de Vigencia: ${formatDateDmy(stamp.validFrom)}`,
      `Fecha de Fin de Vigencia: ${formatDateDmy(stamp.validTo)}`,
      `Factura Electrónica Nº ${documentNumber}`,
    ];
    let middle = top;
    stampLines.forEach((text, i) => {
      middle = this.put(doc, text, 285, middle, { width: 180, bold: i === 0 || i === 4 });
    });
    doc.image(qr.png, doc.page.width - MARGIN - qr.size, top - 4, {
      width: qr.size,
      height: qr.size,
    });
    return Math.max(left, middle, top - 4 + qr.size);
  }

  private general(doc: Doc, invoice: KudeInvoice, top: number): number {
    const width = doc.page.width - 2 * MARGIN;
    const { receiver } = invoice;
    doc
      .moveTo(MARGIN, top - 4)
      .lineTo(MARGIN + width, top - 4)
      .stroke();
    const rows: string[] = [
      [
        `Fecha y hora de emisión: ${invoice.issuedAt}`,
        `Condición de Venta: ${invoice.operationCondition}`,
        invoice.installments === undefined ? '' : `Cuotas: ${String(invoice.installments)}`,
        `Moneda: ${invoice.currency}`,
        invoice.exchangeRate === undefined ? '' : `Tipo de Cambio: ${invoice.exchangeRate}`,
      ]
        .filter(Boolean)
        .join('    '),
    ];
    if (receiver.kind === 'named') {
      rows.push(
        `RUC/Documento de Identidad Nº: ${receiver.document}`,
        `Nombre o Razón Social: ${receiver.name}`,
      );
      if (receiver.address) rows.push(`Dirección: ${receiver.address}`);
      const contact = [
        receiver.phone ? `Teléfono: ${receiver.phone}` : '',
        receiver.email ? `Correo Electrónico: ${receiver.email}` : '',
      ].filter(Boolean);
      if (contact.length > 0) rows.push(contact.join('    '));
    } else {
      rows.push('Nombre o Razón Social: Sin Nombre');
    }
    rows.push(`Tipo de Operación: ${invoice.transactionType}`);
    let y = top;
    for (const text of rows) y = this.put(doc, text, MARGIN, y, { width });
    return y + 8;
  }

  private tableHeader(doc: Doc, y: number): number {
    let x = MARGIN;
    for (const column of COLUMNS) {
      this.line(doc, column.title, x, y, {
        width: column.width - 3,
        align: column.align,
        bold: true,
      });
      x += column.width;
    }
    doc
      .moveTo(MARGIN, y + 11)
      .lineTo(x, y + 11)
      .stroke();
    return y + 15;
  }

  private items(doc: Doc, items: KudeItem[], start: number): number {
    let y = this.tableHeader(doc, start);
    for (const item of items) {
      const values = cells(item);
      doc.font('regular').fontSize(8);
      // The row is as tall as its tallest cell; amounts never wrap (they shrink instead).
      const height = Math.max(
        10,
        ...COLUMNS.filter((c) => c.wrap).map((c) =>
          doc.heightOfString(sanitize(values[c.key]), { width: c.width - 3 }),
        ),
      );
      if (y + height > doc.page.height - BOTTOM) {
        doc.addPage();
        y = this.tableHeader(doc, MARGIN);
      }
      let x = MARGIN;
      for (const column of COLUMNS) {
        if (column.wrap) {
          doc
            .font('regular')
            .fontSize(8)
            .text(sanitize(values[column.key]), x, y, { width: column.width - 3 });
        } else {
          this.line(doc, values[column.key], x, y, { width: column.width - 3, align: 'right' });
        }
        x += column.width;
      }
      y += height + 3;
    }
    return y;
  }

  private totals(doc: Doc, invoice: KudeInvoice, start: number): void {
    const { totals } = invoice;
    let y = start;
    if (y + FOOTER_BLOCK > doc.page.height - BOTTOM) {
      doc.addPage();
      y = MARGIN;
    }
    const width = doc.page.width - 2 * MARGIN;
    doc
      .moveTo(MARGIN, y)
      .lineTo(MARGIN + width, y)
      .stroke();
    y += 5;
    const subtotals: [string, number][] = [
      ['exempt', totals.subtotalExempt],
      ['vat5', totals.subtotal5],
      ['vat10', totals.subtotal10],
    ];
    this.line(doc, 'SUBTOTAL', MARGIN, y, { bold: true });
    let x = MARGIN + COLUMNS.slice(0, 6).reduce((sum, column) => sum + column.width, 0);
    for (const [key, amount] of subtotals) {
      const column = COLUMNS.find((c) => c.key === key);
      this.line(doc, formatPyg(amount), x, y, { width: (column?.width ?? 50) - 3, align: 'right' });
      x += column?.width ?? 50;
    }
    const summary = [
      `TOTAL DE LA OPERACIÓN: ${formatPyg(totals.totalOperation)}`,
      `TOTAL EN GUARANÍES: ${formatPyg(totals.totalGs)}`,
      `LIQUIDACIÓN IVA: (5%) ${formatPyg(totals.vat5)} (10%) ${formatPyg(totals.vat10)}`,
      `TOTAL IVA: ${formatPyg(totals.totalVat)}`,
    ];
    summary.forEach((text, i) => {
      this.line(doc, text, MARGIN, y + 16 + i * 12, { bold: true, size: 9 });
    });
    y += 16 + summary.length * 12 + 12;
    this.line(doc, 'Información de consulta en SIFEN', MARGIN, y, { bold: true });
    this.line(
      doc,
      'Consulte la validez de esta Factura Electrónica con el número de CDC impreso abajo en:',
      MARGIN,
      y + 12,
      {},
    );
    this.line(doc, KUDE_CONSULT_URL[invoice.environment], MARGIN, y + 24, { bold: true });
    this.line(doc, groupCdc(invoice.cdc), MARGIN, y + 38, { bold: true, size: 10 });
  }

  /** MT 13.3: "n/total" on every page; written after layout, when the total is known. */
  private pageNumbers(doc: Doc): void {
    const { count } = doc.bufferedPageRange();
    for (let i = 0; i < count; i += 1) {
      doc.switchToPage(i);
      // Drawing inside the bottom margin would make pdfkit open a new page.
      doc.page.margins.bottom = 0;
      this.line(doc, `Página ${String(i + 1)}/${String(count)}`, MARGIN, doc.page.height - 30, {
        width: doc.page.width - 2 * MARGIN,
        align: 'right',
      });
    }
  }
}
