import type { QrGenerator } from '@sifen/sifen-gateway';
import { validateXml } from '@sifen/sifen-xsd';
import { verifyQrUrl, type QrEnvironment, type QrExpectations } from '../domain/qr.js';

/** The QR cannot be added or does not verify; the message never contains the CSC. */
export class InvoiceQrError extends Error {
  constructor(reason: string) {
    super(`Invalid invoice QR: ${reason}`);
    this.name = 'InvoiceQrError';
  }
}

export interface InvoiceQrOptions {
  environment: QrEnvironment;
  idCsc: string;
  /** Plaintext from CscVault.getPlaintext; only its SHA-256 leaves this function. */
  csc: string;
}

const tag = (xml: string, name: string): string | undefined =>
  new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];

/** Independent reading of the signed document: what the QR has to say. */
function readExpectations(xml: string, options: InvoiceQrOptions): QrExpectations {
  const cdc = /<DE\b[^>]*\bId="(\d{44})"/.exec(xml)?.[1];
  const issuedAt = tag(xml, 'dFeEmiDE');
  const digestValue = tag(xml, 'DigestValue');
  const ruc = tag(xml, 'dRucRec');
  // MT 13.8.2: a parameter without a value is completed with "0".
  const receiver = ruc
    ? ({ kind: 'ruc', value: ruc } as const)
    : ({ kind: 'document', value: tag(xml, 'dNumIDRec') || '0' } as const);
  if (!cdc || !issuedAt || !digestValue) {
    throw new InvoiceQrError('the XML is not a signed invoice with the data the QR needs');
  }
  return {
    environment: options.environment,
    cdc,
    issuedAt,
    receiver,
    totalOperation: tag(xml, 'dTotGralOpe') || '0',
    totalVat: tag(xml, 'dTotIVA') || '0',
    itemCount: (xml.match(/<gCamItem>/g) ?? []).length,
    digestValue,
    idCsc: options.idCsc,
  };
}

/**
 * Adds gCamFuFD/dCarQR to a signed invoice through the `QrGenerator` port, then
 * trusts neither the library nor its XML: the final document must pass the strict
 * siRecepDE XSD and the QR must match an independent recomputation (HU-E5-06).
 */
export async function addQrToSignedInvoice(
  generator: QrGenerator,
  signedXml: string,
  options: InvoiceQrOptions,
): Promise<string> {
  const expected = readExpectations(signedXml, options);
  const xml = await generator.addQr(signedXml, {
    idCsc: options.idCsc,
    csc: options.csc,
    ambiente: options.environment === 'production' ? 'prod' : 'test',
  });

  // First, so that no later message (XSD errors echo the offending text) can carry the CSC.
  if (xml.includes(options.csc)) throw new InvoiceQrError('the CSC leaked into the XML');

  const { errors } = validateXml(xml, 'siRecepDE');
  if (errors.length > 0) throw new InvoiceQrError(errors.map((e) => e.message).join('; '));

  const url = tag(xml, 'dCarQR');
  if (!url) throw new InvoiceQrError('the generator did not add dCarQR');
  const findings = verifyQrUrl(url, expected, options.csc);
  if (findings.length > 0) throw new InvoiceQrError(`QR mismatch in ${findings.join(', ')}`);
  return xml;
}
