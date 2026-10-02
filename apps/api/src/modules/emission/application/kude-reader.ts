import type { KudeInvoice, KudeItem } from '../domain/kude-model.js';
import { qrBaseUrl } from '../domain/qr.js';

/** The signed DE cannot be turned into a KuDE; `field` names the XML element at fault. */
export class KudeSourceError extends Error {
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(`Cannot build the KuDE: ${field} ${reason}`);
    this.name = 'KudeSourceError';
  }
}

const NAME = '(?:[\\w.-]+:)?';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decodes the five predefined XML entities and numeric character references. */
function unescapeXml(text: string): string {
  return text.replace(
    /&(?:#x([\da-f]+)|#(\d+)|(\w+));/gi,
    (whole, hex?: string, dec?: string, named?: string) => {
      if (named !== undefined) return Object.hasOwn(ENTITIES, named) ? ENTITIES[named] : whole;
      const code = hex !== undefined ? parseInt(hex, 16) : Number(dec);
      const surrogate = code >= 0xd800 && code <= 0xdfff;
      return code > 0 && code <= 0x10ffff && !surrogate ? String.fromCodePoint(code) : whole;
    },
  );
}

/** Text of the first `<name>` in `source`, tolerant to namespace prefixes and attributes. */
function optional(source: string, name: string): string | undefined {
  const match = new RegExp(`<${NAME}${name}(?:\\s[^>]*)?>([^<]*)</${NAME}${name}>`).exec(source);
  return match?.[1] === undefined ? undefined : unescapeXml(match[1]).trim();
}

function required(source: string, name: string): string {
  const value = optional(source, name);
  if (value === undefined || value === '') throw new KudeSourceError(name, 'is missing');
  return value;
}

/** PYG amounts are whole numbers; anything else means the XML is not what we can print. */
function pyg(source: string, name: string, fallback?: number): number {
  const text = optional(source, name);
  if (text === undefined || text === '') {
    if (fallback === undefined) throw new KudeSourceError(name, 'is missing');
    return fallback;
  }
  if (!/^-?\d+(\.0+)?$/.test(text))
    throw new KudeSourceError(name, `is not a PYG integer: ${text}`);
  return Number(text);
}

function section(source: string, name: string): string {
  const match = new RegExp(`<${NAME}${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${NAME}${name}>`).exec(
    source,
  );
  if (!match) throw new KudeSourceError(name, 'is missing');
  return match[1];
}

function readItem(block: string): KudeItem {
  const rate = pyg(block, 'dTasaIVA');
  if (rate !== 0 && rate !== 5 && rate !== 10)
    throw new KudeSourceError('dTasaIVA', `unsupported rate ${String(rate)}`);
  const quantity = Number(required(block, 'dCantProSer'));
  if (!Number.isFinite(quantity)) throw new KudeSourceError('dCantProSer', 'is not a number');
  return {
    code: optional(block, 'dCodInt') ?? '',
    description: required(block, 'dDesProSer'),
    unit: optional(block, 'dDesUniMed') ?? '',
    quantity,
    unitPrice: pyg(block, 'dPUniProSer'),
    discount: pyg(block, 'dDescItem', 0),
    vatRate: rate,
    total: pyg(block, 'dTotOpeItem'),
  };
}

/**
 * Builds the KuDE model from the signed DE (with `dCarQR`). Nothing is recomputed: the VAT
 * liquidation and totals are the ones the XML carries (MT 13.2: the KuDE shows no data that
 * is not in the signed XML). FE only; `options.stampValidTo` supplies C009, which the DE
 * v150 XSD does not carry.
 */
export function readKudeInvoice(xml: string, options: { stampValidTo?: string } = {}): KudeInvoice {
  const cdc = /<DE\b[^>]*\bId="(\d{44})"/.exec(xml)?.[1];
  if (!cdc) throw new KudeSourceError('CDC (DE/@Id)', 'is missing');
  const timbrado = section(xml, 'gTimb');
  if (required(timbrado, 'iTiDE') !== '1')
    throw new KudeSourceError('iTiDE', 'unsupported: only the FE KuDE exists');
  const qrUrl = required(section(xml, 'gCamFuFD'), 'dCarQR');
  const environment = qrUrl.startsWith(qrBaseUrl('production'))
    ? 'production'
    : qrUrl.startsWith(qrBaseUrl('test'))
      ? 'test'
      : undefined;
  if (!environment)
    throw new KudeSourceError('dCarQR', 'does not point to the SET consultation portal');

  const emitter = section(xml, 'gEmis');
  const receiverBlock = section(xml, 'gDatRec');
  const totals = section(xml, 'gTotSub');
  const general = section(xml, 'gDatGralOpe');
  const operation = section(general, 'gOpeCom');
  const condition = section(xml, 'gCamCond');
  const currency = required(operation, 'cMoneOpe');
  if (currency !== 'PYG') {
    throw new KudeSourceError('cMoneOpe', `is ${currency}: only PYG KuDEs are supported`);
  }
  const items = [
    ...xml.matchAll(
      new RegExp(`<${NAME}gCamItem(?:\\s[^>]*)?>([\\s\\S]*?)</${NAME}gCamItem>`, 'g'),
    ),
  ].map((m) => readItem(m[1]));
  if (items.length === 0) throw new KudeSourceError('gCamItem', 'at least one item is required');

  const rucRec = optional(receiverBlock, 'dRucRec');
  const receiver: KudeInvoice['receiver'] =
    rucRec === undefined && optional(receiverBlock, 'iTipIDRec') === '5'
      ? { kind: 'unnamed' }
      : {
          kind: 'named',
          document:
            rucRec === undefined
              ? required(receiverBlock, 'dNumIDRec')
              : `${rucRec.replace(/^0+(?=\d)/, '')}-${required(receiverBlock, 'dDVRec')}`,
          name: required(receiverBlock, 'dNomRec'),
          address: optional(receiverBlock, 'dDirRec'),
          phone: optional(receiverBlock, 'dTelRec'),
          email: optional(receiverBlock, 'dEmailRec'),
        };

  const total = pyg(totals, 'dTotGralOpe');
  return {
    environment,
    cdc,
    qrUrl,
    issuer: {
      name: required(emitter, 'dNomEmi'),
      tradeName: optional(emitter, 'dNomFanEmi'),
      activity: optional(emitter, 'dDesActEco'),
      address: required(emitter, 'dDirEmi'),
      city: required(emitter, 'dDesCiuEmi'),
      ruc: `${required(emitter, 'dRucEm').replace(/^0+(?=\d)/, '')}-${required(emitter, 'dDVEmi')}`,
    },
    stamp: {
      number: required(timbrado, 'dNumTim'),
      validFrom: required(timbrado, 'dFeIniT'),
      validTo: options.stampValidTo,
    },
    establishment: required(timbrado, 'dEst'),
    point: required(timbrado, 'dPunExp'),
    documentNumber: required(timbrado, 'dNumDoc'),
    issuedAt: required(general, 'dFeEmiDE'),
    operationCondition: required(condition, 'dDCondOpe'),
    installments:
      optional(condition, 'dCuotas') === undefined ? undefined : pyg(condition, 'dCuotas'),
    currency,
    exchangeRate: optional(operation, 'dTiCam'),
    receiver,
    transactionType: required(operation, 'dDesTipTra'),
    items,
    totals: {
      subtotalExempt: pyg(totals, 'dSubExe', 0) + pyg(totals, 'dSubExo', 0),
      subtotal5: pyg(totals, 'dSub5', 0),
      subtotal10: pyg(totals, 'dSub10', 0),
      totalOperation: total,
      totalGs: pyg(totals, 'dTotalGs', total),
      vat5: pyg(totals, 'dIVA5', 0),
      vat10: pyg(totals, 'dIVA10', 0),
      totalVat: pyg(totals, 'dTotIVA', 0),
    },
  };
}
