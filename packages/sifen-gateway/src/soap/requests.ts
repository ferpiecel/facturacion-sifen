const SIFEN_NS = 'http://ekuatia.set.gov.py/sifen/xsd';
const SOAP_NS = 'http://www.w3.org/2003/05/soap-envelope';
/** `dId` is N(1-15) in every request schema (MT v150 §9): the widest value an envelope can carry. */
export const WIDEST_DID = 999_999_999_999_999n;
const PROTOCOL_NUMBER = /^\d{1,15}$/;

/** @throws RangeError when `dId` is outside 1-15 digits */
export function assertDId(dId: bigint): void {
  if (dId < 1n || dId > WIDEST_DID) throw new RangeError('dId must have 1 to 15 digits');
}

/** SOAP 1.2 envelope (document/literal) whose body is one SIFEN request element. `inner` must already be valid XML. */
export function soapEnvelope(root: string, inner: string): string {
  return (
    `<env:Envelope xmlns:env="${SOAP_NS}"><env:Header/><env:Body>` +
    `<${root} xmlns="${SIFEN_NS}">${inner}</${root}>` +
    '</env:Body></env:Envelope>'
  );
}

/** siResultLoteDE request (MT v150 §9.3.1, schema 7). @throws RangeError on a bad `dId` or protocol number */
export function buildConsultaLoteMessage(dId: bigint, dProtConsLote: string): string {
  assertDId(dId);
  if (!PROTOCOL_NUMBER.test(dProtConsLote))
    throw new RangeError('dProtConsLote must have 1 to 15 digits');
  return soapEnvelope(
    'rEnviConsLoteDe',
    `<dId>${dId.toString()}</dId><dProtConsLote>${dProtConsLote}</dProtConsLote>`,
  );
}
