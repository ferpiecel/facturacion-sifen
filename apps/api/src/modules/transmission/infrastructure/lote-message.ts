import { crc32, deflateRawSync } from 'node:zlib';

/**
 * siRecepLoteDE request (Manual Técnico v150 §9.2): `rEnvioLote` carries `dId` and `xDE`,
 * the Base64 of a ZIP whose XML is `rLoteDE` holding 1-50 signed `rDE` elements.
 */
const SIFEN_NS = 'http://ekuatia.set.gov.py/sifen/xsd';
const SOAP_NS = 'http://www.w3.org/2003/05/soap-envelope';
const ENTRY_NAME = 'lote.xml';
/** `dId` is N(1-15), so this is the widest value the envelope can carry. */
const WIDEST_DID = 999_999_999_999_999n;
/** 1980-01-01 00:00:00, the ZIP epoch: fixed so the bytes (and the measure) are reproducible. */
const DOS_TIME = 0;
const DOS_DATE = 0x21;
const XML_DECLARATION = /^\s*<\?xml[^?]*\?>\s*/;

/** The signed DE is embedded as an element: its own XML declaration must go. */
const embeddable = (xml: string): string => xml.replace(XML_DECLARATION, '').trim();

function assertLote(xmls: readonly string[]): void {
  if (xmls.length === 0) throw new RangeError('A lote needs at least one document');
}

/**
 * Deterministic single-entry ZIP (deflate, fixed timestamp). One entry for the whole lote:
 * a ZIP entry is compressed as a unit, so sizes are not additive per document.
 */
export function buildLoteZip(xmls: readonly string[]): Buffer {
  assertLote(xmls);
  const xml = `<?xml version="1.0" encoding="UTF-8"?><rLoteDE>${xmls.map(embeddable).join('')}</rLoteDE>`;
  const data = Buffer.from(xml, 'utf8');
  const compressed = deflateRawSync(data, { level: 9 });
  const name = Buffer.from(ENTRY_NAME, 'utf8');
  const checksum = crc32(data);

  const shared = Buffer.alloc(26);
  shared.writeUInt16LE(20, 0); // version needed to extract
  shared.writeUInt16LE(0, 2); // flags
  shared.writeUInt16LE(8, 4); // deflate
  shared.writeUInt16LE(DOS_TIME, 6);
  shared.writeUInt16LE(DOS_DATE, 8);
  shared.writeUInt32LE(checksum, 10);
  shared.writeUInt32LE(compressed.length, 14);
  shared.writeUInt32LE(data.length, 18);
  shared.writeUInt16LE(name.length, 22);
  shared.writeUInt16LE(0, 24); // extra field length

  const local = Buffer.concat([u32(0x04034b50), shared, name, compressed]);

  const centralHeader = Buffer.concat([
    u32(0x02014b50),
    u16(20), // version made by
    shared, // version needed .. extra length
    Buffer.alloc(10), // comment length, disk, internal/external attributes
    u32(0), // local header offset
    name,
  ]);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8); // entries on this disk
  end.writeUInt16LE(1, 10); // entries total
  end.writeUInt32LE(centralHeader.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, centralHeader, end]);
}

function u16(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value);
  return b;
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
}

/** The SOAP request for `siRecepLoteDE`. @throws RangeError on an empty lote or a `dId` outside 1-15 digits */
export function buildLoteMessage(xmls: readonly string[], dId: bigint): string {
  if (dId < 1n || dId > WIDEST_DID) throw new RangeError('dId must have 1 to 15 digits');
  const xDE = buildLoteZip(xmls).toString('base64');
  return (
    `<env:Envelope xmlns:env="${SOAP_NS}"><env:Header/><env:Body>` +
    `<rEnvioLote xmlns="${SIFEN_NS}"><dId>${dId.toString()}</dId><xDE>${xDE}</xDE></rEnvioLote>` +
    '</env:Body></env:Envelope>'
  );
}

/**
 * Size in bytes of the full message (zip + Base64 + envelope) for these XMLs, with the widest
 * `dId` so the real message, whatever its `dId`, is never larger than what was measured.
 * Cost: one deflate over the whole lote per call, so a LoteBuilder fed up to 50 documents does
 * O(n^2) compression work (measured about 0.9 s to fill 50 documents of ~45 KB of poorly compressible text); acceptable for n <= 50.
 */
export function measureLoteMessage(xmls: readonly string[]): number {
  return Buffer.byteLength(buildLoteMessage(xmls, WIDEST_DID));
}
