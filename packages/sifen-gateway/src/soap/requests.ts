const SIFEN_NS = 'http://ekuatia.set.gov.py/sifen/xsd';
const SOAP_NS = 'http://www.w3.org/2003/05/soap-envelope';
/** `dId` is N(1-15) in every request schema (MT v150 §9): the widest value an envelope can carry. */
export const WIDEST_DID = 999_999_999_999_999n;
const PROTOCOL_NUMBER = /^\d{1,15}$/;
const RUC = /^\d{5,8}$/;
const XML_DECLARATION = /^\s*<\?xml[^?]*\?>\s*/;
/** MT v150 §9.5 / port: events per siRecepEvento call. */
const MAX_EVENTOS = 15;

/** A signed document is embedded as an element: its own XML declaration must go. */
export const embeddable = (xml: string): string => xml.replace(XML_DECLARATION, '').trim();

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

/** siRecepDE request (MT v150 §7.4 example): `rEnviDe` carries `dId` and the signed `rDE` inside `xDE`. */
export function buildEnvioDEMessage(dId: bigint, de: string): string {
  assertDId(dId);
  return soapEnvelope('rEnviDe', `<dId>${dId.toString()}</dId><xDE>${embeddable(de)}</xDE>`);
}

/** siConsDE request (MT v150 §9.4.1, schema 9). The CDC is already validated by its type. */
export function buildConsultaDEMessage(dId: bigint, cdc: string): string {
  assertDId(dId);
  return soapEnvelope('rEnviConsDe', `<dId>${dId.toString()}</dId><dCDC>${cdc}</dCDC>`);
}

/** siConsRUC request (MT v150 §9.6.1, schema 15). @throws RangeError unless the RUC is 5-8 digits without check digit */
export function buildConsultaRUCMessage(dId: bigint, ruc: string): string {
  assertDId(dId);
  if (!RUC.test(ruc)) throw new RangeError('ruc must have 5 to 8 digits, without the check digit');
  return soapEnvelope('rEnviConsRUC', `<dId>${dId.toString()}</dId><dRUCCons>${ruc}</dRUCCons>`);
}

/** siRecepEvento request (MT v150 §9.5.1, schema 13). @throws RangeError unless 1-15 events */
export function buildEventosMessage(dId: bigint, eventos: readonly string[]): string {
  assertDId(dId);
  if (eventos.length < 1 || eventos.length > MAX_EVENTOS) {
    throw new RangeError(`A call carries 1 to ${String(MAX_EVENTOS)} events`);
  }
  return soapEnvelope(
    'rEnviEventoDe',
    `<dId>${dId.toString()}</dId><dEvReg>${eventos.map(embeddable).join('')}</dEvReg>`,
  );
}
