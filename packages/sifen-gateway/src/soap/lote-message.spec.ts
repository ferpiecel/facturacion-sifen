import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildLoteMessage, buildLoteZip, measureLoteMessage } from './lote-message.ts';

const DE_1 =
  '<?xml version="1.0" encoding="UTF-8"?>\n<rDE xmlns="http://ekuatia.set.gov.py/sifen/xsd"><DE Id="1">uno</DE></rDE>\n';
const DE_2 = '<rDE xmlns="http://ekuatia.set.gov.py/sifen/xsd"><DE Id="2">dos ñandú</DE></rDE>';

/** Minimal reader: single-entry ZIP -> { name, method, content, crc ok }. */
function readZip(zip: Buffer) {
  expect(zip.readUInt32LE(0)).toBe(0x04034b50);
  const method = zip.readUInt16LE(8);
  const crc = zip.readUInt32LE(14);
  const compressedSize = zip.readUInt32LE(18);
  const size = zip.readUInt32LE(22);
  const nameLength = zip.readUInt16LE(26);
  const extraLength = zip.readUInt16LE(28);
  const name = zip.subarray(30, 30 + nameLength).toString('utf8');
  const start = 30 + nameLength + extraLength;
  const content = inflateRawSync(zip.subarray(start, start + compressedSize));
  const eocd = zip.length - 22;
  return {
    name,
    method,
    crc,
    size,
    content: content.toString('utf8'),
    contentLength: content.length,
    entries: zip.readUInt16LE(eocd + 10),
    centralHeader: zip.readUInt32LE(zip.readUInt32LE(eocd + 16)),
  };
}

describe('buildLoteZip', () => {
  it('packs one lote.xml entry with the rDE elements inside rLoteDE, without XML declarations', () => {
    const entry = readZip(buildLoteZip([DE_1, DE_2]));
    expect(entry.name).toBe('lote.xml');
    expect(entry.method).toBe(8);
    expect(entry.entries).toBe(1);
    expect(entry.centralHeader).toBe(0x02014b50);
    expect(entry.size).toBe(entry.contentLength);
    expect(entry.content).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><rLoteDE>' +
        '<rDE xmlns="http://ekuatia.set.gov.py/sifen/xsd"><DE Id="1">uno</DE></rDE>' +
        DE_2 +
        '</rLoteDE>',
    );
  });

  it('is deterministic', () => {
    expect(buildLoteZip([DE_1, DE_2]).equals(buildLoteZip([DE_1, DE_2]))).toBe(true);
  });
});

describe('buildLoteMessage', () => {
  it('wraps the Base64 zip in a SOAP rEnvioLote with the dId', () => {
    const message = buildLoteMessage([DE_1, DE_2], 123n);
    const match =
      /^<env:Envelope xmlns:env="http:\/\/www\.w3\.org\/2003\/05\/soap-envelope"><env:Header\/><env:Body><rEnvioLote xmlns="http:\/\/ekuatia\.set\.gov\.py\/sifen\/xsd"><dId>123<\/dId><xDE>([A-Za-z0-9+/=]+)<\/xDE><\/rEnvioLote><\/env:Body><\/env:Envelope>$/.exec(
        message,
      );
    expect(match).not.toBeNull();
    const zip = Buffer.from(match?.[1] ?? '', 'base64');
    expect(zip.equals(buildLoteZip([DE_1, DE_2]))).toBe(true);
  });

  it.each([0n, -1n, 1_000_000_000_000_000n])('rejects the dId %s (1 to 15 digits)', (dId) => {
    expect(() => buildLoteMessage([DE_1], dId)).toThrow(RangeError);
  });

  it('refuses an empty lote', () => {
    expect(() => buildLoteMessage([], 1n)).toThrow(RangeError);
  });
});

describe('measureLoteMessage', () => {
  it('measures the full envelope in bytes, assuming the widest (15-digit) dId', () => {
    const widest = Buffer.byteLength(buildLoteMessage([DE_1, DE_2], 999_999_999_999_999n));
    expect(measureLoteMessage([DE_1, DE_2])).toBe(widest);
    expect(measureLoteMessage([DE_1, DE_2])).toBeGreaterThanOrEqual(
      Buffer.byteLength(buildLoteMessage([DE_1, DE_2], 1n)),
    );
  });

  it('grows when a document is added', () => {
    expect(measureLoteMessage([DE_1, DE_2])).toBeGreaterThan(measureLoteMessage([DE_1]));
  });
});
