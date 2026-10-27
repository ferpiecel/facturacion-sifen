import { readFileSync } from 'node:fs';
import { create as openFont } from 'fontkit';
import QRCode from 'qrcode';
import { formatDateDmy, type KudeInvoice } from '../../domain/kude-model.js';

export const PT_PER_MM = 72 / 25.4;
/** MT v150 13.8.1: printed QR at least 25 mm wide, 22 mm of content plus the quiet zone. */
const QR_CONTENT_MM = 24;
/** Quiet zone per side, as a share of the QR content (about 12% of the printed width). */
const QR_QUIET_SHARE = 0.16;

/** Noto Sans (SIL OFL 1.1, apps/api/assets/fonts): Latin, Guaraní tildes and the guaraní sign U+20B2. */
const FONT_DIR = new URL('../../../../../assets/fonts/', import.meta.url);

interface Fonts {
  regular: Buffer;
  bold: Buffer;
  covers: (codePoint: number) => boolean;
}

let loaded: Fonts | undefined;
export function fonts(): Fonts {
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
export function sanitize(text: string): string {
  const { covers } = fonts();
  return Array.from(text.normalize('NFC').replace(/[\r\n\t]/g, ' '))
    .map((char) => (covers(char.codePointAt(0) ?? 0) ? char : '?'))
    .join('');
}

/** The QR PNG of the signed `dCarQR` URL and its printed side in points (>= 25 mm). */
export async function renderQr(invoice: KudeInvoice): Promise<{ png: Buffer; size: number }> {
  const modules = QRCode.create(invoice.qrUrl, { errorCorrectionLevel: 'M' }).modules.size;
  const quiet = Math.ceil(modules * QR_QUIET_SHARE);
  return {
    png: await QRCode.toBuffer(invoice.qrUrl, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: quiet,
      scale: 4,
    }),
    size: ((QR_CONTENT_MM * (modules + 2 * quiet)) / modules) * PT_PER_MM,
  };
}

/** The motive, the trip, the places, the vehicle and the carrier of an NRE, one printed row each. */
export function remissionRows(remission: NonNullable<KudeInvoice['remission']>): string[] {
  const day = (iso: string | undefined) => (iso === undefined ? '' : formatDateDmy(iso));
  const trip = [day(remission.startDate), day(remission.endDate)].filter(Boolean).join(' - ');
  return [
    `Motivo del traslado: ${remission.motive}`,
    `Responsable de la emisión: ${remission.responsible}`,
    `Kilómetros estimados: ${String(remission.km)}`,
    ...(remission.invoiceDate === undefined
      ? []
      : [`Fecha de la factura: ${day(remission.invoiceDate)}`]),
    ...(trip === '' ? [] : [`Traslado: ${trip}`]),
    `Salida: ${remission.departure}`,
    `Entrega: ${remission.delivery}`,
    `Vehículo: ${remission.vehicle}`,
    `Transportista: ${remission.carrier}`,
    `Conductor: ${remission.driver}`,
  ];
}
