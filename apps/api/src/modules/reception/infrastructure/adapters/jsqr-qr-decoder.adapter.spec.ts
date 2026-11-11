import { deflateSync } from 'node:zlib';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { createCdcReference } from '../../domain/cdc-reference.js';
import { JsqrQrDecoder } from './jsqr-qr-decoder.adapter.js';

/** Anonymous CDC with a valid check digit (fake RUC), also used by the domain specs. */
const CDC = '01444444017001001001452822017012515873260988';
const SIFEN_URL = `https://ekuatia.set.gov.py/consultas/qr?nVersion=150&Id=${CDC}&dFeEmiDE=313031&dRucRec=1`;

interface Raster {
  readonly width: number;
  readonly height: number;
  readonly rgba: Buffer;
}

interface RenderOptions {
  readonly module?: number;
  readonly quiet?: number;
  readonly invert?: boolean;
  readonly rotate?: boolean;
  /** Extra white margin in pixels around the code, e.g. to mimic a photo of a page. */
  readonly margin?: number;
}

/** Renders a QR matrix as an opaque RGBA raster; fixtures are generated, never real images. */
function renderQr(text: string, options: RenderOptions = {}): Raster {
  const { module = 6, quiet = 4, invert = false, rotate = false, margin = 0 } = options;
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = modules.size;
  const dark = (row: number, col: number): boolean => {
    const [r, c] = rotate ? [col, size - 1 - row] : [row, col];
    return r >= 0 && c >= 0 && r < size && c < size && modules.get(r, c) === 1;
  };
  const side = (size + quiet * 2) * module + margin * 2;
  const rgba = Buffer.alloc(side * side * 4, 255);
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const row = Math.floor((y - margin) / module) - quiet;
      const col = Math.floor((x - margin) / module) - quiet;
      const inside = y >= margin && x >= margin && y < side - margin && x < side - margin;
      const black = inside && dark(row, col);
      const value = black !== invert ? 0 : 255;
      const at = (y * side + x) * 4;
      rgba[at] = value;
      rgba[at + 1] = value;
      rgba[at + 2] = value;
    }
  }
  return { width: side, height: side, rgba };
}

const toPng = ({ width, height, rgba }: Raster): Buffer => {
  const png = new PNG({ width, height });
  rgba.copy(png.data);
  return PNG.sync.write(png);
};

const toJpeg = ({ width, height, rgba }: Raster, quality = 85): Buffer =>
  Buffer.from(jpeg.encode({ width, height, data: rgba }, quality).data);

const decoder = new JsqrQrDecoder({ maxInputBytes: 20 * 1024 * 1024 });

describe('fixtures', () => {
  it('use a CDC that the domain accepts', () => {
    expect(createCdcReference(CDC).value).toBe(CDC);
  });
});

describe('JsqrQrDecoder.decodeCdc', () => {
  it('reads the CDC from the Id parameter of a SIFEN URL in a PNG', async () => {
    await expect(decoder.decodeCdc(toPng(renderQr(SIFEN_URL)))).resolves.toBe(CDC);
  });

  it('reads the same QR from a JPEG', async () => {
    await expect(decoder.decodeCdc(toJpeg(renderQr(SIFEN_URL)))).resolves.toBe(CDC);
  });

  it('tolerates a bare 44-digit CDC', async () => {
    await expect(decoder.decodeCdc(toPng(renderQr(CDC)))).resolves.toBe(CDC);
  });

  it('tolerates a percent-encoded URL', async () => {
    const encoded = `https://example.test/r?u=${encodeURIComponent(SIFEN_URL)}`;
    await expect(decoder.decodeCdc(toPng(renderQr(encoded)))).resolves.toBe(CDC);
  });

  it('reads a rotated code', async () => {
    await expect(decoder.decodeCdc(toPng(renderQr(SIFEN_URL, { rotate: true })))).resolves.toBe(
      CDC,
    );
  });

  it('reads a light-on-dark (inverted) code', async () => {
    await expect(decoder.decodeCdc(toPng(renderQr(SIFEN_URL, { invert: true })))).resolves.toBe(
      CDC,
    );
  });

  it('reads a code in a large image by scanning at reduced scale', async () => {
    const big = renderQr(SIFEN_URL, { module: 30, margin: 600 });
    expect(Math.max(big.width, big.height)).toBeGreaterThan(2048);
    await expect(decoder.decodeCdc(toJpeg(big, 80))).resolves.toBe(CDC);
  });

  it('returns null for an image without a QR code', async () => {
    const blank: Raster = { width: 120, height: 120, rgba: Buffer.alloc(120 * 120 * 4, 255) };
    await expect(decoder.decodeCdc(toPng(blank))).resolves.toBeNull();
  });

  it('returns null for a QR code that carries no CDC', async () => {
    await expect(
      decoder.decodeCdc(toPng(renderQr('https://example.test/no-cdc-here'))),
    ).resolves.toBeNull();
  });

  it('returns null for a QR whose digits are not a 44-digit CDC', async () => {
    await expect(decoder.decodeCdc(toPng(renderQr('1234567890')))).resolves.toBeNull();
  });

  it('does not verify the check digit (that is left to the use case)', async () => {
    const wrongDigit = `${CDC.slice(0, 43)}0`;
    await expect(decoder.decodeCdc(toPng(renderQr(wrongDigit)))).resolves.toBe(wrongDigit);
  });

  it.each([
    ['empty input', new Uint8Array(0)],
    ['text bytes', Buffer.from('this is not an image')],
    ['a PDF', Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n')],
    ['an unsupported GIF', Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1')],
  ])('returns null for %s', async (_name, bytes) => {
    await expect(decoder.decodeCdc(bytes)).resolves.toBeNull();
  });

  it('returns null for a truncated PNG', async () => {
    const png = toPng(renderQr(SIFEN_URL));
    await expect(decoder.decodeCdc(png.subarray(0, png.length / 2))).resolves.toBeNull();
  });

  it('returns null for a truncated or corrupted JPEG', async () => {
    const image = toJpeg(renderQr(SIFEN_URL));
    await expect(decoder.decodeCdc(image.subarray(0, 30))).resolves.toBeNull();
    const garbled = Buffer.from(image);
    garbled.fill(0x00, 40);
    await expect(decoder.decodeCdc(garbled)).resolves.toBeNull();
  });

  it('refuses input above the byte limit without decoding it', async () => {
    const small = new JsqrQrDecoder({ maxInputBytes: 100 });
    const png = toPng(renderQr(SIFEN_URL));
    expect(png.length).toBeGreaterThan(100);
    await expect(small.decodeCdc(png)).resolves.toBeNull();
  });

  it('refuses a PNG whose header declares too many pixels before decoding it', async () => {
    // A 1 KB file that declares 60000 x 60000 pixels: decoding it would allocate ~14 GB.
    const header = Buffer.alloc(13);
    header.writeUInt32BE(60_000, 0);
    header.writeUInt32BE(60_000, 4);
    header[8] = 8;
    header[9] = 2;
    const chunk = (type: string, data: Buffer): Buffer => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(data.length, 0);
      head.write(type, 4, 'ascii');
      return Buffer.concat([head, data, Buffer.alloc(4)]);
    };
    const bomb = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(Buffer.alloc(1024))),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    const started = Date.now();
    await expect(decoder.decodeCdc(bomb)).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('refuses a JPEG whose header declares too many pixels before decoding it', async () => {
    const image = toJpeg(renderQr(SIFEN_URL));
    const sof = image.indexOf(Buffer.from([0xff, 0xc0]));
    expect(sof).toBeGreaterThan(0);
    const hostile = Buffer.from(image);
    hostile.writeUInt16BE(60_000, sof + 5); // height
    hostile.writeUInt16BE(60_000, sof + 7); // width
    await expect(decoder.decodeCdc(hostile)).resolves.toBeNull();
  });

  it('honours a lower pixel budget', async () => {
    const strict = new JsqrQrDecoder({ maxInputBytes: 20 * 1024 * 1024, maxPixels: 1000 });
    await expect(strict.decodeCdc(toPng(renderQr(SIFEN_URL)))).resolves.toBeNull();
  });
});
