import PDFDocument from 'pdfkit';
import { fromAsuncionTimestamp } from '../../application/invoice-xml.js';
import {
  assertValidKudeInvoice,
  formatDateDmy,
  formatDocumentNumber,
  formatPyg,
  formatQuantity,
  groupCdc,
  KUDE_CONSULT_URL,
  KUDE_CREDIT_NOTE_TITLE,
  KUDE_DEBIT_NOTE_TITLE,
  KUDE_REMISSION_TITLE,
  KUDE_SELF_INVOICE_TITLE,
  KUDE_TITLE,
  documentNumberOfCdc,
  type KudeInvoice,
  type KudeItem,
} from '../../domain/kude-model.js';
import { fonts, PT_PER_MM, remissionRows, renderQr, sanitize } from './kude-pdf-common.js';

type TicketFormat = 'ticket-80' | 'ticket-58';
type Doc = InstanceType<typeof PDFDocument>;
type Align = 'left' | 'right' | 'center';

/** Paper width in mm, font size in pt and side margin in pt of each roll. */
const ROLLS: Record<TicketFormat, { widthMm: number; size: number; margin: number }> = {
  'ticket-80': { widthMm: 80, size: 8, margin: 8 },
  'ticket-58': { widthMm: 58, size: 7, margin: 8 },
};
/** Blank space under the last line, so the printer can tear the paper. */
const TAIL = 24;
/** A page tall enough to lay out any realistic receipt before its real height is known. */
const MEASURE_HEIGHT = 200_000;
const CDC_GROUPS_PER_ROW = 4;

const titleOf = (invoice: KudeInvoice): string =>
  invoice.debitNote
    ? KUDE_DEBIT_NOTE_TITLE
    : invoice.creditNote
      ? KUDE_CREDIT_NOTE_TITLE
      : invoice.selfInvoice
        ? KUDE_SELF_INVOICE_TITLE
        : invoice.remission
          ? KUDE_REMISSION_TITLE
          : KUDE_TITLE;

const rateLabel = (rate: KudeItem['vatRate']): string => (rate === 0 ? 'Ex.' : `${String(rate)}%`);

/**
 * KuDE on a paper roll (MT v150 13.6 "Formato 2", the format for restaurants and retail). One
 * continuous page exactly as wide as the roll and as tall as its content, single column, drawn
 * with embedded Noto Sans. FE and NCE share the layout (same fields); NDE, AFE and NRE add their
 * own rows in `documentRows` when they exist.
 */
export class PdfkitTicketKudeRenderer {
  async render(invoice: KudeInvoice, format: TicketFormat = 'ticket-80'): Promise<Uint8Array> {
    assertValidKudeInvoice(invoice);
    const qr = await renderQr(invoice);
    // Pass 1 lays the receipt out on a very tall page to learn its height; pass 2 draws it again.
    const height = (await this.draw(invoice, format, qr, MEASURE_HEIGHT)).end + TAIL;
    return (await this.draw(invoice, format, qr, height)).pdf;
  }

  private draw(
    invoice: KudeInvoice,
    format: TicketFormat,
    qr: { png: Buffer; size: number },
    height: number,
  ): Promise<{ pdf: Uint8Array; end: number }> {
    const roll = ROLLS[format];
    const created = fromAsuncionTimestamp(invoice.issuedAt);
    const doc = new PDFDocument({
      size: [roll.widthMm * PT_PER_MM, height],
      margin: 0,
      info: {
        Title: `${titleOf(invoice)} ${formatDocumentNumber(invoice.establishment, invoice.point, invoice.documentNumber)}`,
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
    const finished = new Promise<Uint8Array>((resolve, reject) => {
      doc.on('error', reject);
      doc.on('end', () => {
        resolve(new Uint8Array(Buffer.concat(chunks)));
      });
    });
    const end = new Layout(doc, roll.size, roll.margin).receipt(invoice, qr);
    doc.end();
    return finished.then((pdf) => ({ pdf, end }));
  }
}

class Layout {
  private y: number;
  private readonly width: number;

  constructor(
    private readonly doc: Doc,
    private readonly size: number,
    private readonly margin: number,
  ) {
    this.y = margin;
    this.width = doc.page.width - 2 * margin;
  }

  receipt(invoice: KudeInvoice, qr: { png: Buffer; size: number }): number {
    this.header(invoice);
    this.rule();
    this.general(invoice);
    this.rule();
    this.items(invoice.items, invoice.remission !== undefined);
    this.rule();
    if (!invoice.remission) {
      this.totals(invoice);
      this.rule();
    }
    this.consult(invoice, qr);
    return this.y;
  }

  /** A wrapped block of text, advancing `y`. */
  private block(raw: string, options: { align?: Align; bold?: boolean; size?: number } = {}): void {
    const text = sanitize(raw);
    this.doc.font(options.bold ? 'bold' : 'regular').fontSize(options.size ?? this.size);
    this.doc.text(text, this.margin, this.y, { width: this.width, align: options.align ?? 'left' });
    this.y += this.doc.heightOfString(text, { width: this.width }) + 1.5;
  }

  /** `left` and `right` on one line; both shrink together when they do not fit (amounts never split). */
  private pair(rawLeft: string, rawRight: string, bold = false): void {
    const [left, right] = [sanitize(rawLeft), sanitize(rawRight)];
    const base = this.size;
    this.doc.font(bold ? 'bold' : 'regular').fontSize(base);
    const natural = this.doc.widthOfString(left) + this.doc.widthOfString(right) + 6;
    const size = natural > this.width ? (base * this.width) / natural : base;
    this.doc.fontSize(size);
    this.doc.text(left, this.margin, this.y, { lineBreak: false });
    this.doc.text(right, this.margin, this.y, {
      width: this.width,
      align: 'right',
      lineBreak: false,
    });
    this.y += size + 3;
  }

  private rule(): void {
    this.y += 1;
    this.doc
      .moveTo(this.margin, this.y)
      .lineTo(this.margin + this.width, this.y)
      .dash(1, { space: 1.5 })
      .stroke()
      .undash();
    this.y += 4;
  }

  private header(invoice: KudeInvoice): void {
    const { issuer, stamp } = invoice;
    this.block(titleOf(invoice), { align: 'center', bold: true, size: this.size + 1 });
    this.block(issuer.name, { align: 'center', bold: true });
    for (const text of [issuer.tradeName, issuer.activity, issuer.address, issuer.city]) {
      if (text) this.block(text, { align: 'center' });
    }
    this.block(`RUC: ${issuer.ruc}`, { align: 'center', bold: true });
    this.block(`Timbrado Nº ${stamp.number}`, { align: 'center' });
    this.block(`Inicio de Vigencia: ${formatDateDmy(stamp.validFrom)}`, { align: 'center' });
    if (stamp.validTo !== undefined) {
      this.block(`Fin de Vigencia: ${formatDateDmy(stamp.validTo)}`, { align: 'center' });
    }
    this.block(
      invoice.debitNote
        ? 'Nota de Débito Electrónica'
        : invoice.creditNote
          ? 'Nota de Crédito Electrónica'
          : invoice.selfInvoice
            ? 'Autofactura Electrónica'
            : invoice.remission
              ? 'Nota de Remisión Electrónica'
              : 'Factura Electrónica',
      { align: 'center', bold: true },
    );
    this.block(
      `Nº ${formatDocumentNumber(invoice.establishment, invoice.point, invoice.documentNumber)}`,
      { align: 'center', bold: true },
    );
  }

  private general(invoice: KudeInvoice): void {
    const { receiver } = invoice;
    const rows = [`Fecha y hora: ${invoice.issuedAt}`];
    if (invoice.operationCondition !== undefined) {
      rows.push(`Condición: ${invoice.operationCondition}`);
    }
    if (invoice.installments !== undefined) rows.push(`Cuotas: ${String(invoice.installments)}`);
    rows.push(`Moneda: ${invoice.currency}`);
    if (invoice.exchangeRate !== undefined) rows.push(`Tipo de Cambio: ${invoice.exchangeRate}`);
    if (receiver.kind === 'named') {
      rows.push(`RUC/CI: ${receiver.document}`, `Razón Social: ${receiver.name}`);
      if (receiver.address) rows.push(`Dirección: ${receiver.address}`);
      if (receiver.phone) rows.push(`Teléfono: ${receiver.phone}`);
      if (receiver.email) rows.push(`Correo: ${receiver.email}`);
    } else {
      rows.push('Razón Social: Sin Nombre');
    }
    if (invoice.transactionType !== undefined) rows.push(`Operación: ${invoice.transactionType}`);
    if (invoice.selfInvoice) {
      const { seller, place, certificate } = invoice.selfInvoice;
      rows.push(
        `Vendedor: ${seller.name}`,
        `Documento: ${seller.idType} ${seller.idNumber}`,
        `Lugar: ${place}`,
        `Constancia: ${certificate.number}`,
      );
    }
    if (invoice.remission) rows.push(...remissionRows(invoice.remission));
    const note = invoice.debitNote ?? invoice.creditNote;
    if (note) {
      const { reason, associatedCdc } = note;
      rows.push(
        `Motivo: ${reason}`,
        `Factura asociada: ${documentNumberOfCdc(associatedCdc)}`,
        `CDC asociado: ${groupCdc(associatedCdc)}`,
      );
    }
    for (const row of rows) this.block(row);
  }

  private items(items: KudeItem[], quantityOnly: boolean): void {
    for (const item of items) {
      this.block(`${item.code} ${item.description}`);
      if (quantityOnly) {
        this.block(`Cantidad: ${formatQuantity(item.quantity)} ${item.unit}`.trim());
        continue;
      }
      this.pair(
        `${formatQuantity(item.quantity)} x ${formatPyg(item.unitPrice)}`,
        `${formatPyg(item.total)} (${rateLabel(item.vatRate)})`,
      );
      if (item.discount > 0) this.pair('Desc.', `-${formatPyg(item.discount)}`);
    }
  }

  private totals({ totals }: KudeInvoice): void {
    this.pair('SUBTOTAL Exentas', formatPyg(totals.subtotalExempt));
    this.pair('SUBTOTAL 5%', formatPyg(totals.subtotal5));
    this.pair('SUBTOTAL 10%', formatPyg(totals.subtotal10));
    this.y += 2;
    this.pair('TOTAL DE LA OPERACIÓN', formatPyg(totals.totalOperation), true);
    this.pair('TOTAL EN GUARANÍES', formatPyg(totals.totalGs), true);
    this.pair('LIQUIDACIÓN IVA (5%)', formatPyg(totals.vat5));
    this.pair('LIQUIDACIÓN IVA (10%)', formatPyg(totals.vat10));
    this.pair('TOTAL IVA', formatPyg(totals.totalVat), true);
  }

  private consult(invoice: KudeInvoice, qr: { png: Buffer; size: number }): void {
    this.block('Información de consulta en SIFEN', { align: 'center', bold: true });
    this.block('Consulte la validez de este documento con el CDC impreso abajo en:', {
      align: 'center',
    });
    this.fitted(KUDE_CONSULT_URL[invoice.environment], true);
    const groups = groupCdc(invoice.cdc).split(' ');
    for (let i = 0; i < groups.length; i += CDC_GROUPS_PER_ROW) {
      this.block(groups.slice(i, i + CDC_GROUPS_PER_ROW).join(' '), {
        align: 'center',
        bold: true,
      });
    }
    this.y += 4;
    this.doc.image(qr.png, this.margin + (this.width - qr.size) / 2, this.y, {
      width: qr.size,
      height: qr.size,
    });
    this.y += qr.size;
  }

  /** One centered line that shrinks until it fits (a URL has no break opportunity worth taking). */
  private fitted(raw: string, bold: boolean): void {
    const text = sanitize(raw);
    this.doc.font(bold ? 'bold' : 'regular').fontSize(this.size);
    const natural = this.doc.widthOfString(text);
    const size = natural > this.width ? (this.size * this.width) / natural : this.size;
    this.doc.fontSize(size);
    this.doc.text(text, this.margin, this.y, {
      width: this.width,
      align: 'center',
      lineBreak: false,
    });
    this.y += size + 3;
  }
}
