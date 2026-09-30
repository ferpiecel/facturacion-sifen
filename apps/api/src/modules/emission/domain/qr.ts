import { createHash } from 'node:crypto';

export type QrEnvironment = 'test' | 'production';

/** QR consultation endpoints fixed by NT 010 (plan v1.1 §8.8). */
const BASE_URLS: Record<QrEnvironment, string> = {
  test: 'https://ekuatia.set.gov.py/consultas-test/qr?',
  production: 'https://ekuatia.set.gov.py/consultas/qr?',
};

const QR_VERSION = '150';

export function qrBaseUrl(environment: QrEnvironment): string {
  return BASE_URLS[environment];
}

/** cHashQR: SHA-256 hex of the URL parameters (without cHashQR) concatenated with the CSC. */
export function computeQrHash(params: string, csc: string): string {
  return createHash('sha256')
    .update(params + csc)
    .digest('hex');
}

/** What the signed document says; the QR must agree with it parameter by parameter. */
export interface QrExpectations {
  environment: QrEnvironment;
  /** DE Id attribute. */
  cdc: string;
  /** dFeEmiDE as written in the XML, `YYYY-MM-DDThh:mm:ss`. */
  issuedAt: string;
  /** Contributor RUC (dRucRec, no check digit) or the identity document number (dNumIDRec, "0" when unnamed). */
  receiver: { kind: 'ruc' | 'document'; value: string };
  /** Raw element text; "0" when the document has no value (MT 13.8.2 note). */
  totalOperation: string;
  totalVat: string;
  itemCount: number;
  /** Base64 DigestValue of the signature. */
  digestValue: string;
  idCsc: string;
}

const toHex = (text: string): string => Buffer.from(text, 'utf8').toString('hex');

/**
 * Recomputes every QR parameter from the document and the CSC, without trusting the
 * QR library. Returns the names of the offending parameters (empty when valid); the
 * CSC never appears in the findings.
 */
export function verifyQrUrl(url: string, expected: QrExpectations, csc: string): string[] {
  const findings: string[] = [];
  const plain = url.replaceAll('&amp;', '&');
  const base = qrBaseUrl(expected.environment);
  if (!plain.startsWith(base)) return ['baseUrl'];

  const query = plain.slice(base.length);
  const hashAt = query.lastIndexOf('&cHashQR=');
  const params = hashAt < 0 ? query : query.slice(0, hashAt);
  const hash = hashAt < 0 ? '' : query.slice(hashAt + '&cHashQR='.length);

  const receiverName = expected.receiver.kind === 'ruc' ? 'dRucRec' : 'dNumIDRec';
  const wanted: [string, string][] = [
    ['nVersion', QR_VERSION],
    ['Id', expected.cdc],
    ['dFeEmiDE', toHex(expected.issuedAt)],
    [receiverName, expected.receiver.value],
    ['dTotGralOpe', expected.totalOperation],
    ['dTotIVA', expected.totalVat],
    ['cItems', String(expected.itemCount)],
    ['DigestValue', toHex(expected.digestValue)],
    ['IdCSC', expected.idCsc],
  ];

  // Exact parameter names, order and values: the hash covers this exact string.
  const actual = params.split('&');
  const got = new Map(actual.map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));
  for (const [name, value] of wanted) if (got.get(name) !== value) findings.push(name);
  if (findings.length === 0 && params !== wanted.map(([n, v]) => `${n}=${v}`).join('&')) {
    findings.push('params');
  }
  if (hash !== computeQrHash(params, csc)) findings.push('cHashQR');
  return findings;
}
