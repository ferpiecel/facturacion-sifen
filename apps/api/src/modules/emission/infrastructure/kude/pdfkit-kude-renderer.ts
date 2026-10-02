import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import type { KudeRenderer } from '../../application/ports/kude-renderer.port.js';
import { fromAsuncionTimestamp } from '../../application/invoice-xml.js';
import {
  formatDateDmy,
  formatDocumentNumber,
  formatPyg,
  formatQuantity,
  KUDE_TITLE,
  type KudeInvoice,
  type KudeItem,
} from '../../domain/kude-model.js';

const PT_PER_MM = 72 / 25.4;
/** MT v150 13.8.1: printed QR at least 25 mm wide (22 mm content + 3 mm quiet zone). */
const QR_MM = 30;
const MARGIN = 36;
const BOTTOM = 60;

const COLUMNS = [
  { key: 'code', title: 'Cód.', width: 45, align: 'left' },
  { key: 'description', title: 'Descripción', width: 150, align: 'left' },
  { key: 'unit', title: 'Unidad', width: 35, align: 'left' },
  { key: 'quantity', title: 'Cant.', width: 40, align: 'right' },
  { key: 'unitPrice', title: 'Precio Unit.', width: 58, align: 'right' },
  { key: 'discount', title: 'Descuento', width: 40, align: 'right' },
  { key: 'exempt', title: 'Exentas', width: 55, align: 'right' },
  { key: 'vat5', title: '5%', width: 50, align: 'right' },
  { key: 'vat10', title: '10%', width: 50, align: 'right' },
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

/** KuDE of an FE on A4 (MT v150 chapter 13, "Formato 1"), drawn with pdfkit's standard Helvetica. */
export class PdfkitKudeRenderer implements KudeRenderer {
  async render(invoice: KudeInvoice): Promise<Uint8Array> {
    const qr = await QRCode.toBuffer(invoice.qrUrl, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 4,
      scale: 4,
    });
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
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    const done = new Promise<Uint8Array>((resolve) => {
      doc.on('end', () => {
        resolve(new Uint8Array(Buffer.concat(chunks)));
      });
    });

    this.header(doc, invoice, qr);
    const y = this.general(doc, invoice, 160);
    this.items(doc, invoice.items, y);
    doc.end();
    return done;
  }

  private line(
    doc: Doc,
    text: string,
    x: number,
    y: number,
    options: { width?: number; align?: 'left' | 'right' | 'center'; bold?: boolean; size?: number },
  ): void {
    doc
      .font(options.bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(options.size ?? 8)
      .text(text, x, y, { width: options.width, align: options.align, lineBreak: false });
  }

  private header(doc: Doc, invoice: KudeInvoice, qr: Buffer): void {
    const { issuer, stamp } = invoice;
    const width = doc.page.width - 2 * MARGIN;
    this.line(doc, KUDE_TITLE, MARGIN, MARGIN, { width, align: 'center', bold: true, size: 14 });
    const top = 64;
    this.line(doc, issuer.name, MARGIN, top, { bold: true, size: 10, width: 235 });
    let y = top + 14;
    for (const text of [
      issuer.tradeName,
      issuer.activity,
      issuer.address,
      `Ciudad: ${issuer.city}`,
    ]) {
      if (text) {
        this.line(doc, text, MARGIN, y, { width: 235 });
        y += 11;
      }
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
    stampLines.forEach((text, i) => {
      this.line(doc, text, 285, top + i * 13, { width: 180, bold: i === 0 || i === 4 });
    });
    const size = QR_MM * PT_PER_MM;
    doc.image(qr, doc.page.width - MARGIN - size, top - 4, { width: size, height: size });
  }

  private general(doc: Doc, invoice: KudeInvoice, top: number): number {
    const width = doc.page.width - 2 * MARGIN;
    const { receiver } = invoice;
    doc
      .moveTo(MARGIN, top - 4)
      .lineTo(MARGIN + width, top - 4)
      .stroke();
    const rows: string[] = [
      `Fecha y hora de emisión: ${invoice.issuedAt}    Condición de Venta: ${invoice.operationCondition}    Moneda: ${invoice.currency}`,
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
    rows.forEach((text, i) => {
      this.line(doc, text, MARGIN, top + i * 12, { width });
    });
    return top + rows.length * 12 + 10;
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
      doc.font('Helvetica').fontSize(8);
      const height = Math.max(
        doc.heightOfString(values.description, { width: COLUMNS[1].width - 3 }),
        10,
      );
      if (y + height > doc.page.height - BOTTOM) {
        doc.addPage();
        y = this.tableHeader(doc, MARGIN);
      }
      let x = MARGIN;
      for (const column of COLUMNS) {
        doc
          .font('Helvetica')
          .fontSize(8)
          .text(values[column.key], x, y, { width: column.width - 3, align: column.align });
        x += column.width;
      }
      y += height + 3;
    }
    return y;
  }
}
