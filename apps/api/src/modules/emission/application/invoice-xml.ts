import type { DeXmlBuilder, FacturaPocInput } from '@sifen/sifen-gateway';
import { validateXml } from '@sifen/sifen-xsd';
import {
  resolveIssuerDocumentContent,
  type TenantEnvironment,
} from '../../fiscal-config/domain/document-environment.js';
import type { Establishment } from '../../fiscal-config/domain/establishment.js';
import type { ExpeditionPoint } from '../../fiscal-config/domain/expedition-point.js';
import {
  TAXPAYER_TYPE_CODES,
  type FiscalProfile,
} from '../../fiscal-config/domain/fiscal-profile.js';
import { getDepartmentDescription } from '../../fiscal-config/domain/department.js';
import { formatRuc } from '../../fiscal-config/domain/ruc.js';
import type { Timbrado } from '../../fiscal-config/domain/timbrado.js';
import type { GeoCatalog } from '../../geo/domain/geo-catalog.js';
import { buildCdc } from '../domain/cdc.js';
import { Decimal } from '../domain/decimal.js';
import {
  validateInvoiceDraft,
  type InvoiceDraft,
  type ValidationConfig,
} from '../domain/invoice-draft.js';
import { invoiceTotals, lineTotal, parseAmount } from '../domain/invoice-totals.js';

/** The draft, the XSD check or the XML post-processing cannot produce a valid document. */
export class InvoiceXmlError extends Error {
  constructor(reason: string) {
    super(`Invalid invoice XML: ${reason}`);
    this.name = 'InvoiceXmlError';
  }
}

/** Named receiver data that the draft does not carry (D2 group of the MT). */
export interface XmlReceiver {
  /** `<base>-<dv>`. */
  ruc: string;
  name: string;
  /** D213-D223 are optional (0-1); the draft rules decide which combinations reach this mapper. */
  address?: string;
  houseNumber?: string;
  districtCode?: number;
  districtDescription?: string;
  cityCode?: number;
  cityDescription?: string;
}

export interface InvoiceXmlContext {
  environment: TenantEnvironment;
  issuer: FiscalProfile;
  establishment: Establishment;
  /** Establishment contact (dTelEmi, dEmailE, dDenSuc) that the establishment entity does not hold yet. */
  establishmentContact: { phone: string; email: string; name: string };
  point: ExpeditionPoint;
  timbrado: Timbrado;
  /** dNumDoc and dCodSeg, already allocated by the numbering services. */
  numbering: { documentNumber: string; securityCode: string };
  /** Emission instant; dFeEmiDE and the CDC date are derived in America/Asuncion. */
  issuedAt: Date;
  /** Named receiver data; absent for an unnamed (innominado) receiver, which has none. */
  receiver?: XmlReceiver;
  /** One entry per draft item, in order: dCodInt, dDesProSer, cUniMed. */
  lines: readonly { code: string; description: string; unitCode: number }[];
  /** Overrides the test literal (ADR-0012 D2). */
  testLiteral?: string;
}

/**
 * D213-D223 for xmlgen, only for what is informed. B2F (D202 = 4) never carries department or
 * city (D219/D223): the caller passes no department and the city is dropped here. The district stays.
 */
function receiverAddress(receiver: XmlReceiver, departmentCode: number | undefined) {
  if (receiver.address === undefined) return {};
  const withGeo = departmentCode !== undefined;
  return {
    direccion: receiver.address,
    ...(receiver.houseNumber === undefined ? {} : { numeroCasa: receiver.houseNumber }),
    ...(withGeo
      ? {
          departamento: departmentCode,
          departamentoDescripcion: getDepartmentDescription(departmentCode),
        }
      : {}),
    ...(receiver.districtCode !== undefined
      ? { distrito: receiver.districtCode, distritoDescripcion: receiver.districtDescription }
      : {}),
    ...(withGeo && receiver.cityCode !== undefined
      ? { ciudad: receiver.cityCode, ciudadDescripcion: receiver.cityDescription }
      : {}),
  };
}

function requireNamedReceiver(receiver: XmlReceiver | undefined): XmlReceiver {
  if (receiver === undefined) throw new InvoiceXmlError('a named receiver needs its D2 data');
  return receiver;
}

function namedReceiverInput(
  receiver: XmlReceiver,
  operationType: number,
  departmentCode: number | undefined,
) {
  return {
    contribuyente: true,
    ruc: receiver.ruc,
    razonSocial: receiver.name,
    tipoOperacion: operationType,
    ...receiverAddress(receiver, departmentCode),
    pais: 'PRY',
    paisDescripcion: 'Paraguay',
    tipoContribuyente: 1,
    documentoTipo: 1,
    documentoNumero: receiver.ruc.split('-')[0],
    codigo: '0001',
  };
}

/**
 * Innominado receiver (MT v150 D201 = 2, D208 = 5, D210 = 0, D211 = "Sin Nombre"; B2C only, NT 024
 * caps the total). It carries no RUC, taxpayer type, address block or customer code; xmlgen fills
 * iTipIDRec 5, dDTipIDRec "Innominado", dNumIDRec "0" and dNomRec "Sin Nombre".
 */
function unnamedReceiverInput(operationType: number) {
  return {
    contribuyente: false,
    razonSocial: 'Sin Nombre',
    tipoOperacion: operationType,
    pais: 'PRY',
    paisDescripcion: 'Paraguay',
    documentoTipo: 5,
    documentoNumero: '0',
  };
}

/** Inverse of `asuncionTimestamp`: the instant whose Paraguay local time is `local` (`AAAA-MM-DDThh:mm:ss`). */
export function fromAsuncionTimestamp(local: string): Date {
  const asIfUtc = Date.parse(`${local}Z`);
  const offset = asIfUtc - Date.parse(`${asuncionTimestamp(new Date(asIfUtc))}Z`);
  return new Date(asIfUtc + offset);
}

const ASUNCION_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Asuncion',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** MT format `AAAA-MM-DDThh:mm:ss` for an instant, in Paraguay local time. */
export function asuncionTimestamp(instant: Date): string {
  const p = Object.fromEntries(
    ASUNCION_FORMAT.formatToParts(instant).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

/**
 * PROVISIONAL until T1 (Prevalidador confirms how SIFEN wants PYG decimals; see ADR-0018): the 8
 * decimals in subtotals and IVA sums may have to go back to integers like integer documents.
 *
 * xmlgen options for documents whose amounts carry decimals (ADR-0018): keep 8 decimals in item
 * totals and subtotals instead of rounding to integers, and leave the 50 Gs rounding to
 * `finalizeDecimalAmounts` (xmlgen's SEDECO rounding only understands integers). Never sent for
 * integer documents, so their XML does not change.
 */
const DECIMAL_XMLGEN_OPTIONS = {
  pygDecimals: 8,
  pygTaxDecimals: 8,
  redondeoSedeco: false,
} as const;

/** Amount and quantity elements xmlgen prints: the only ones whose exponent notation is rewritten. */
const AMOUNT_TAGS = [
  'dPUniProSer',
  'dCantProSer',
  'dDescItem',
  'dDescGloItem',
  'dAntPreUniIt',
  'dAntGloPreUniIt',
  'dTotBruOpeItem',
  'dTotOpeItem',
  'dBasGravIVA',
  'dLiqIVAItem',
  'dBasExe',
  'dMonTiPag',
  'dSubExe',
  'dSubExo',
  'dSub5',
  'dSub10',
  'dTotOpe',
  'dTotDesc',
  'dTotDescGlotem',
  'dTotAntItem',
  'dTotAnt',
  'dPorcDescTotal',
  'dDescTotal',
  'dAnticipo',
  'dRedon',
  'dComi',
  'dTotGralOpe',
  'dIVA5',
  'dIVA10',
  'dLiqTotIVA5',
  'dLiqTotIVA10',
  'dTotIVA',
  'dBaseGrav5',
  'dBaseGrav10',
  'dTBasGraIVA',
  'dTotalGs',
];
const EXPONENT_AMOUNT = new RegExp(
  `(<(?:${AMOUNT_TAGS.join('|')})>)(-?\\d+(?:\\.\\d+)?e[+-]?\\d+)(</)`,
  'g',
);

/** True when a line total or the rounding is not a whole number of guaranies. */
function hasDecimalAmounts(draft: InvoiceDraft): boolean {
  const roundingDecimals = parseAmount(draft.roundingPyg)?.decimalPlaces() ?? 0;
  return (
    roundingDecimals > 0 || draft.items.some((item) => (lineTotal(item)?.decimalPlaces() ?? 0) > 0)
  );
}

/** Whole numbers keep going as `number` (same bytes as before); the rest as plain strings. */
const plainOrNumber = (value: number): number | string =>
  Number.isInteger(value) ? value : (parseAmount(value)?.toString() ?? value);

/**
 * Maps the draft and its fiscal context to the xmlgen input (params + data). The draft has been
 * validated (amounts are exact decimals, integers unless `allowDecimals`) before this runs.
 */
export function mapInvoiceToXmlInput(draft: InvoiceDraft, ctx: InvoiceXmlContext): FacturaPocInput {
  const { issuer, establishment: est } = ctx;
  const content = resolveIssuerDocumentContent(
    ctx.environment,
    { legalName: issuer.legalName, firstItemDescription: ctx.lines[0]?.description ?? '' },
    ctx.testLiteral,
  );
  const { net } = invoiceTotals(draft);
  const operationType = { B2B: 1, B2C: 2, B2G: 3, B2F: 4 }[draft.operationType];
  const { departmentCode } = draft.location;

  return {
    params: {
      version: 150,
      ruc: formatRuc(issuer.ruc),
      razonSocial: content.legalName,
      nombreFantasia: issuer.tradeName ?? undefined,
      actividadesEconomicas: issuer.economicActivities.map((a) => ({
        codigo: a.code,
        descripcion: a.description,
      })),
      timbradoNumero: ctx.timbrado.number,
      timbradoFecha: ctx.timbrado.validityStart,
      tipoContribuyente: TAXPAYER_TYPE_CODES[issuer.taxpayerType],
      tipoRegimen: issuer.regimeCode === null ? undefined : Number(issuer.regimeCode),
      establecimientos: [
        {
          codigo: est.code,
          direccion: est.address,
          numeroCasa: est.houseNumber,
          departamento: est.departmentCode,
          departamentoDescripcion: est.departmentDescription,
          distrito: Number(est.districtCode),
          distritoDescripcion: est.districtDescription,
          ciudad: Number(est.cityCode),
          ciudadDescripcion: est.cityDescription,
          telefono: ctx.establishmentContact.phone,
          email: ctx.establishmentContact.email,
          denominacion: ctx.establishmentContact.name,
        },
      ],
    },
    data: {
      tipoDocumento: 1,
      establecimiento: est.code,
      punto: ctx.point.code,
      numero: ctx.numbering.documentNumber,
      codigoSeguridadAleatorio: ctx.numbering.securityCode,
      fecha: asuncionTimestamp(ctx.issuedAt),
      // xmlgen formats dFecFirma with the process-local clock; an explicit Asuncion wall time
      // (no zone, re-read as local and printed back unchanged) keeps it correct under any TZ.
      fechaFirmaDigital: asuncionTimestamp(new Date()),
      // TODO(E6): tipoEmision is always 1 (normal); contingencia (2) comes with E6.
      tipoEmision: 1,
      // TODO: tipoTransaccion is always 1 (venta de mercaderia); other transaction types are pending.
      tipoTransaccion: 1,
      tipoImpuesto: 1,
      moneda: 'PYG',
      condicionAnticipo: 1,
      condicionTipoCambio: 1,
      descuentoGlobal: 0,
      anticipoGlobal: 0,
      cambio: 0,
      cliente:
        draft.receiver.kind === 'unnamed'
          ? unnamedReceiverInput(operationType)
          : namedReceiverInput(
              requireNamedReceiver(ctx.receiver),
              operationType,
              draft.operationType === 'B2F' ? undefined : departmentCode,
            ),
      factura: { presencia: 1 },
      condicion: {
        tipo: 1,
        entregas: [{ tipo: 1, monto: net.toString(), moneda: 'PYG', cambio: 0 }],
      },
      items: draft.items.map((item, i) => ({
        codigo: ctx.lines[i]?.code,
        descripcion: i === 0 ? content.firstItemDescription : ctx.lines[i]?.description,
        unidadMedida: ctx.lines[i]?.unitCode,
        cantidad: plainOrNumber(item.quantity),
        precioUnitario: plainOrNumber(item.unitPrice),
        cambio: 0,
        descuento: 0,
        anticipo: 0,
        pais: 'PRY',
        paisDescripcion: 'Paraguay',
        ivaTipo: item.vatRate === 0 ? 3 : 1,
        ivaProporcion: item.vatRate === 0 ? 0 : 100,
        iva: item.vatRate,
      })),
    },
    ...(hasDecimalAmounts(draft) ? { config: DECIMAL_XMLGEN_OPTIONS } : {}),
  };
}

/**
 * Decimal documents only: sets dRedon and dTotGralOpe from the validated totals and rewrites any
 * exponent number xmlgen printed (`1e-7`) as a plain decimal, which the XSD requires.
 */
function finalizeDecimalAmounts(xml: string, draft: InvoiceDraft): string {
  const { net } = invoiceTotals(draft);
  const rounding = parseAmount(draft.roundingPyg)?.toString() ?? '0';
  return xml
    .replace(/<dRedon>[^<]*<\/dRedon>/, `<dRedon>${rounding}</dRedon>`)
    .replace(/<dTotGralOpe>[^<]*<\/dTotGralOpe>/, `<dTotGralOpe>${net.toString()}</dTotGralOpe>`)
    .replace(EXPONENT_AMOUNT, (whole, open: string, text: string, close: string) => {
      const plain = Decimal.parse(Number(text));
      return plain.ok ? `${open}${plain.value.toString()}${close}` : whole;
    });
}

interface GeoExpectation {
  codeTag: string;
  descriptionTag: string;
  /** The validated code; with `strict` the XML must carry exactly this one. */
  code: number | undefined;
  nameOf: (code: number) => string | undefined;
}

/**
 * xmlgen looks the department, district and city text up in its own table and derives the
 * department and district from the city. Here the XML is held to the DNIT catalog: the
 * description is the catalog's for the code the XML carries and, when `strict` (the draft was
 * validated against the catalog), a code other than the validated one is an override and fails.
 */
function patchGeoGroup(
  xml: string,
  group: string,
  expectations: GeoExpectation[],
  strict: boolean,
): string {
  const block = new RegExp(`<${group}>[\\s\\S]*?</${group}>`).exec(xml);
  if (block === null) return xml;
  let patched = block[0];
  for (const { codeTag, descriptionTag, code, nameOf } of expectations) {
    const pair = new RegExp(
      `<${codeTag}>(\\d+)</${codeTag}><${descriptionTag}>([^<]*)</${descriptionTag}>`,
    );
    const found = pair.exec(patched);
    if (found === null) continue;
    const carried = Number(found[1]);
    if (strict && code !== undefined && carried !== code) {
      throw new InvoiceXmlError(
        `${codeTag} is ${found[1]} but the validated code is ${String(code)}`,
      );
    }
    const name = nameOf(carried);
    if (name !== undefined && unescapeXmlText(found[2]) !== name) {
      // A function replacement: the text is literal, `$&`-style patterns must not be interpreted.
      patched = patched.replace(
        pair,
        () =>
          `<${codeTag}>${found[1]}</${codeTag}><${descriptionTag}>${escapeText(name)}</${descriptionTag}>`,
      );
    }
  }
  return xml.replace(block[0], () => patched);
}

function geoExpectations(
  suffix: 'Rec' | 'Emi',
  codes: { department?: number; district?: number; city?: number },
  catalog: GeoCatalog,
): GeoExpectation[] {
  const parts: [string, number | undefined, GeoExpectation['nameOf']][] = [
    ['Dep', codes.department, (c) => catalog.department(c)?.name],
    ['Dis', codes.district, (c) => catalog.district(c)?.name],
    ['Ciu', codes.city, (c) => catalog.city(c)?.name],
  ];
  return parts.map(([part, code, nameOf]) => ({
    codeTag: `c${part}${suffix}`,
    descriptionTag: `dDes${part}${suffix}`,
    code,
    nameOf,
  }));
}

function applyCatalogGeography(
  xml: string,
  draft: InvoiceDraft,
  ctx: InvoiceXmlContext,
  validation: ValidationConfig & { geoCatalog: GeoCatalog },
): string {
  const { geoCatalog: catalog } = validation;
  const strict = validation.validateGeo === true;
  const { establishment: est } = ctx;
  const issued = patchGeoGroup(
    xml,
    'gEmis',
    geoExpectations(
      'Emi',
      {
        department: est.departmentCode,
        district: est.districtCode === null ? undefined : Number(est.districtCode),
        city: Number(est.cityCode),
      },
      catalog,
    ),
    strict,
  );
  const address = draft.receiver.kind === 'named' ? draft.receiver.address : undefined;
  if (address === undefined) return issued;
  // The district falls back to the city's, which is what xmlgen derives when it is not informed.
  const district =
    address.districtCode ??
    (address.cityCode === undefined ? undefined : catalog.city(address.cityCode)?.districtCode);
  return patchGeoGroup(
    issued,
    'gDatRec',
    geoExpectations(
      'Rec',
      { department: draft.location.departmentCode, district, city: address.cityCode },
      catalog,
    ),
    strict,
  );
}

/** The one libxml2 error an unsigned, otherwise valid rDE produces (verified in the spec). */
const MISSING_SIGNATURE =
  "Element '{http://ekuatia.set.gov.py/sifen/xsd}rDE': Missing child element(s). Expected is ( {http://www.w3.org/2000/09/xmldsig#}Signature ).";

/**
 * xmlgen validates its input and crashes on a code missing from its tables. Both are deterministic
 * data problems: they surface as an `InvoiceXmlError` (the document is held with a clear reason)
 * instead of an opaque crash that would be retried forever.
 */
async function buildWithXmlgen(
  builder: DeXmlBuilder,
  input: ReturnType<typeof mapInvoiceToXmlInput>,
): Promise<string> {
  try {
    return await builder.buildParaSifen(input);
  } catch (error) {
    // xmlgen reads `.descripcion` of the row it looks a code up by; a missing row is that TypeError.
    // Any other TypeError is a bug and propagates unchanged.
    if (error instanceof TypeError) {
      if (!/reading 'descripcion'/.test(error.message)) throw error;
      throw new InvoiceXmlError(
        `a department, district or city code is not in the xmlgen geographic table (${error.message})`,
      );
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new InvoiceXmlError(`xmlgen could not build the document: ${reason}`);
  }
}

/**
 * Validates the draft, builds the DE through the `DeXmlBuilder` port, checks
 * it against the siRecepDE XSD and verifies the Id attribute is the CDC of the
 * numbering results. The XML is not signed yet, so the only tolerated XSD error
 * is the missing `ds:Signature`; the complete XSD check runs after signing.
 */
export async function generateInvoiceXml(
  builder: DeXmlBuilder,
  draft: InvoiceDraft,
  ctx: InvoiceXmlContext,
  validation: ValidationConfig = {},
): Promise<{ xml: string; cdc: string }> {
  const draftErrors = validateInvoiceDraft(draft, validation);
  if (draftErrors.length > 0) {
    throw new InvoiceXmlError(draftErrors.map((e) => `${e.field} (${e.rule})`).join(', '));
  }
  // xmlgen emits an empty cTipReg when the regime is unknown; the XSD makes it optional (MT 7.2.4: no empty tags).
  const built = (await buildWithXmlgen(builder, mapInvoiceToXmlInput(draft, ctx))).replace(
    /<cTipReg><\/cTipReg>|<cTipReg\/>/,
    '',
  );
  const geoBuilt = validation.geoCatalog
    ? applyCatalogGeography(built, draft, ctx, { ...validation, geoCatalog: validation.geoCatalog })
    : built;
  const xml = hasDecimalAmounts(draft) ? finalizeDecimalAmounts(geoBuilt, draft) : geoBuilt;

  const { errors } = validateXml(xml, 'siRecepDE');
  const [only] = errors;
  if (errors.length !== 1 || only.message !== MISSING_SIGNATURE || only.path !== '/*') {
    throw new InvoiceXmlError(errors.map((e) => e.message).join('; '));
  }

  const cdc = buildCdc({
    documentType: '01',
    rucBase: ctx.issuer.ruc.base,
    rucDv: ctx.issuer.ruc.dv,
    establishment: ctx.establishment.code,
    point: ctx.point.code,
    documentNumber: ctx.numbering.documentNumber,
    taxpayerType: TAXPAYER_TYPE_CODES[ctx.issuer.taxpayerType],
    issueDate: asuncionTimestamp(ctx.issuedAt).slice(0, 10),
    emissionType: 1,
    securityCode: ctx.numbering.securityCode,
  });
  const rootDe = new RegExp(
    `<rDE\\b[^>]*>\\s*<dVerFor>[^<]*</dVerFor>\\s*<DE\\b[^>]*\\bId="${cdc}"`,
  );
  if (!rootDe.test(xml)) {
    throw new InvoiceXmlError('the DE Id attribute does not match the expected CDC');
  }
  return { xml, cdc };
}

const GCAMFUFD = /(<gCamFuFD\b[^>]*>)([\s\S]*?)(<\/gCamFuFD>)/;
const INF_ADIC = /<dInfAdic\b[^>]*\/>|<dInfAdic\b[^>]*>[\s\S]*?<\/dInfAdic>/g;
// eslint-disable-next-line no-control-regex -- stripping XML 1.0 illegal characters is the point
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/** Applies `edit` to the body of the gCamFuFD group only (J001), leaving the rest of the document alone. */
function editFuFd(xml: string, edit: (body: string) => string): string {
  return xml.replace(
    GCAMFUFD,
    (_m, open: string, body: string, close: string) => open + edit(body) + close,
  );
}

/** Version sent to SIFEN: no dInfAdic (J003), which SIFEN rejects with 2503. */
export function toSifenXml(xml: string): string {
  return editFuFd(xml, (body) => body.replace(INF_ADIC, ''));
}

export function unescapeXmlText(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

export function escapeText(text: string): string {
  return text
    .replace(XML_ILLEGAL, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** Version kept for the receiver: dInfAdic (J003) goes right after dCarQR in gCamFuFD. */
export function toReceiverXml(xml: string, additionalInfo: string): string {
  if (!GCAMFUFD.test(xml) || !/<gCamFuFD\b[\s\S]*<\/dCarQR>[\s\S]*<\/gCamFuFD>/.test(xml)) {
    throw new InvoiceXmlError('dInfAdic needs the gCamFuFD/dCarQR block (add the QR first)');
  }
  return editFuFd(toSifenXml(xml), (body) =>
    body.replace('</dCarQR>', `</dCarQR><dInfAdic>${escapeText(additionalInfo)}</dInfAdic>`),
  );
}
