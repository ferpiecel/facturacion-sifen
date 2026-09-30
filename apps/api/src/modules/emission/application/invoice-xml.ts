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
import { buildCdc } from '../domain/cdc.js';
import { validateInvoiceDraft, type InvoiceDraft } from '../domain/invoice-draft.js';

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
  address: string;
  houseNumber: string;
  districtCode: number;
  districtDescription: string;
  cityCode: number;
  cityDescription: string;
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
  /** dFeEmiDE, `YYYY-MM-DDTHH:mm:ss`. */
  issuedAt: string;
  receiver: XmlReceiver;
  /** One entry per draft item, in order: dCodInt, dDesProSer, cUniMed. */
  lines: readonly { code: string; description: string; unitCode: number }[];
  /** Overrides the test literal (ADR-0012 D2). */
  testLiteral?: string;
}

const ROUNDING_CONFIG = {};

/** Maps the draft and its fiscal context to the xmlgen input (params + data). */
export function mapInvoiceToXmlInput(draft: InvoiceDraft, ctx: InvoiceXmlContext): FacturaPocInput {
  if (draft.receiver.kind === 'unnamed') {
    throw new InvoiceXmlError('an unnamed receiver is not supported yet');
  }
  const { issuer, establishment: est, receiver } = ctx;
  const content = resolveIssuerDocumentContent(
    ctx.environment,
    { legalName: issuer.legalName, firstItemDescription: ctx.lines[0]?.description ?? '' },
    ctx.testLiteral,
  );
  const total = draft.items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
  const operationType = { B2B: 1, B2C: 2, B2G: 3, B2F: 4 }[draft.operationType];

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
      fecha: ctx.issuedAt,
      tipoEmision: 1,
      tipoTransaccion: 1,
      tipoImpuesto: 1,
      moneda: 'PYG',
      condicionAnticipo: 1,
      condicionTipoCambio: 1,
      descuentoGlobal: 0,
      anticipoGlobal: 0,
      cambio: 0,
      cliente: {
        contribuyente: true,
        ruc: receiver.ruc,
        razonSocial: receiver.name,
        tipoOperacion: operationType,
        direccion: receiver.address,
        numeroCasa: receiver.houseNumber,
        departamento: draft.location.departmentCode,
        departamentoDescripcion: getDepartmentDescription(draft.location.departmentCode),
        distrito: receiver.districtCode,
        distritoDescripcion: receiver.districtDescription,
        ciudad: receiver.cityCode,
        ciudadDescripcion: receiver.cityDescription,
        pais: 'PRY',
        paisDescripcion: 'Paraguay',
        tipoContribuyente: 1,
        documentoTipo: 1,
        documentoNumero: receiver.ruc.split('-')[0],
        codigo: '0001',
      },
      factura: { presencia: 1 },
      condicion: {
        tipo: 1,
        entregas: [{ tipo: 1, monto: String(total - draft.roundingPyg), moneda: 'PYG', cambio: 0 }],
      },
      items: draft.items.map((item, i) => ({
        codigo: ctx.lines[i]?.code,
        descripcion: i === 0 ? content.firstItemDescription : ctx.lines[i]?.description,
        unidadMedida: ctx.lines[i]?.unitCode,
        cantidad: item.quantity,
        precioUnitario: item.unitPrice,
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
  };
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
): Promise<{ xml: string; cdc: string }> {
  const draftErrors = validateInvoiceDraft(draft, ROUNDING_CONFIG);
  if (draftErrors.length > 0) {
    throw new InvoiceXmlError(draftErrors.map((e) => `${e.field} (${e.rule})`).join(', '));
  }
  const xml = await builder.buildParaSifen(mapInvoiceToXmlInput(draft, ctx));

  const errors = validateXml(xml, 'siRecepDE').errors.filter(
    (e) => !e.message.includes('Signature'),
  );
  if (errors.length > 0) throw new InvoiceXmlError(errors.map((e) => e.message).join('; '));

  const cdc = buildCdc({
    documentType: '01',
    rucBase: ctx.issuer.ruc.base,
    rucDv: ctx.issuer.ruc.dv,
    establishment: ctx.establishment.code,
    point: ctx.point.code,
    documentNumber: ctx.numbering.documentNumber,
    taxpayerType: TAXPAYER_TYPE_CODES[ctx.issuer.taxpayerType],
    issueDate: ctx.issuedAt.slice(0, 10),
    emissionType: 1,
    securityCode: ctx.numbering.securityCode,
  });
  if (!xml.includes(`<DE Id="${cdc}">`)) {
    throw new InvoiceXmlError('the DE Id attribute does not match the expected CDC');
  }
  return { xml, cdc };
}

const INF_ADIC = /<dInfAdic>[\s\S]*?<\/dInfAdic>/g;

/** Version sent to SIFEN: no dInfAdic (J003), which SIFEN rejects with 2503. */
export function toSifenXml(xml: string): string {
  return xml.replace(INF_ADIC, '');
}

/** Version kept for the receiver: dInfAdic (J003) goes right after dCarQR in gCamFuFD. */
export function toReceiverXml(xml: string, additionalInfo: string): string {
  if (!xml.includes('</dCarQR>')) {
    throw new InvoiceXmlError('dInfAdic needs the gCamFuFD/dCarQR block (add the QR first)');
  }
  const escaped = additionalInfo
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  return toSifenXml(xml).replace('</dCarQR>', `</dCarQR><dInfAdic>${escaped}</dInfAdic>`);
}
