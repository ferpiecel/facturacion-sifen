import { createHash } from 'node:crypto';
import { Decimal } from '../../emission/domain/decimal.js';
import {
  createReceivedDocument,
  transitionReceivedDocument,
  type ReceivedDocument,
} from '../domain/received-document.js';
import { validateReceivedDocument } from '../domain/received-document-validation.js';
import { matchReceiver } from '../domain/receiver-match.js';
import type { ReceptionEventType } from '../domain/reception-events.js';
import type {
  FieldConfidence,
  NewReceivedArtifact,
  ReceivedDocumentHeaderInput,
  ReceivedDocumentItem,
  ReceivedDocumentRepository,
} from './ports/received-document-repository.port.js';
import {
  MalformedSifenXmlError,
  SifenXmlTooLargeError,
  UnsupportedDocumentTypeError,
  type ParsedSifenDocument,
  type SifenXmlParser,
} from './ports/sifen-xml-parser.port.js';
import type { StorageProvider } from './ports/storage-provider.port.js';
import type { TenantFiscalIdentity } from './ports/tenant-fiscal-identity.port.js';
import { toReceivedDocumentFields } from './to-received-document-fields.js';

export interface IngestSifenXmlDeps {
  readonly repository: ReceivedDocumentRepository;
  readonly storage: StorageProvider;
  readonly parser: SifenXmlParser;
  readonly fiscalIdentity: TenantFiscalIdentity;
  readonly now: () => Date;
  readonly newId: () => string;
}

export interface IngestSifenXmlInput {
  readonly tenantId: string;
  readonly xml: Uint8Array;
  readonly originalName?: string | null;
}

export interface IngestSifenXmlResult {
  /** False when the upload (same bytes) or the CDC was already ingested; nothing was written. */
  readonly created: boolean;
  readonly document: ReceivedDocument;
  /** Events the caller must enqueue; always empty for deduped and receiver-mismatch documents. */
  readonly events: readonly ReceptionEventType[];
}

const CONTENT_TYPE = 'application/xml';
/** Every field comes straight from the XML, not from a model, so it is fully trusted. */
const FULL_CONFIDENCE = '1.0';
const CONFIDENCE_FIELDS = [
  'issuer_ruc',
  'issuer_legal_name',
  'issued_on',
  'document_number',
  'receiver_ruc',
  'payment_condition',
  'totals',
  'items',
] as const;

/**
 * Ingests a SIFEN `rDE` XML (reception R3.3). The raw bytes reach object storage before parsing,
 * so a parser bug never loses an upload. Logging is the caller's job and must carry ids only.
 */
export class IngestSifenXml {
  constructor(private readonly deps: IngestSifenXmlDeps) {}

  async execute(input: IngestSifenXmlInput): Promise<IngestSifenXmlResult> {
    const { repository, storage, parser, fiscalIdentity } = this.deps;
    const { tenantId, xml } = input;

    const sha256 = createHash('sha256').update(xml).digest('hex');
    const known = await repository.findArtifactBySha256(tenantId, sha256);
    if (known?.document) return { created: false, document: known.document, events: [] };

    const storageKey = `tenants/${tenantId}/received/sifen_xml/${sha256}.xml`;
    await storage.upload(storageKey, xml, { contentType: CONTENT_TYPE });
    const artifact: NewReceivedArtifact = {
      storageKey,
      contentType: CONTENT_TYPE,
      sha256,
      sizeBytes: xml.byteLength,
      originalName: input.originalName ?? null,
      pageCount: null,
    };

    let parsed: ParsedSifenDocument;
    try {
      parsed = parser.parse(xml);
    } catch (error) {
      const code = extractionErrorCode(error);
      if (code === null) throw error;
      return this.persistFailure(tenantId, artifact, code);
    }

    const byCdc = await repository.findByCdc(tenantId, parsed.cdc);
    if (byCdc) {
      // Same document, different bytes (e.g. re-signed): keep the first, drop the extra upload.
      await storage.delete(storageKey);
      return { created: false, document: byCdc, events: [] };
    }

    const identity = await fiscalIdentity.getRucIdentity(tenantId);
    const receiverRuc = parsed.receiver.ruc;
    const receiverText =
      receiverRuc === null || parsed.receiver.dv === null
        ? receiverRuc
        : `${receiverRuc}-${parsed.receiver.dv}`;
    // Anything that cannot be proven to be the tenant's (no profile, no receiver RUC) is not own.
    const isOwnReceiver = identity !== null && matchReceiver(receiverText, identity) === 'match';

    const reasons = validateReceivedDocument(toReceivedDocumentFields(parsed));
    const at = this.deps.now();
    const base = createReceivedDocument({
      id: this.deps.newId(),
      tenantId,
      source: 'sifen_xml',
      isOwnReceiver,
    });
    const extracted = transitionReceivedDocument(base, 'extracted', {
      at,
      confidenceOverall: FULL_CONFIDENCE,
    }).document;
    const final =
      reasons.length === 0
        ? transitionReceivedDocument(extracted, 'confirmed', { at })
        : transitionReceivedDocument(extracted, 'needs_review', { at, reasons });

    const result = await repository.create(tenantId, {
      document: final.document,
      header: toHeader(parsed),
      items: parsed.items.map(toItem),
      confidences: CONFIDENCE_FIELDS.map(toConfidence),
      artifact,
    });
    if (!result.created) return { created: false, document: result.document, events: [] };
    return {
      created: true,
      document: result.document,
      events: final.event === null ? [] : [final.event],
    };
  }

  /**
   * The upload stays stored and gets a document in `extraction_failed` (received -> extracting ->
   * extraction_failed, version 1) so the failure is visible and reprocessable. Without a parsed
   * receiver nothing proves a mismatch, so the document is treated as the tenant's own.
   */
  private async persistFailure(
    tenantId: string,
    artifact: NewReceivedArtifact,
    code: string,
  ): Promise<IngestSifenXmlResult> {
    const at = this.deps.now();
    const base = createReceivedDocument({
      id: this.deps.newId(),
      tenantId,
      source: 'sifen_xml',
      isOwnReceiver: true,
    });
    const extracting = transitionReceivedDocument(base, 'extracting', { at }).document;
    const failed = transitionReceivedDocument(extracting, 'extraction_failed', { at });
    const result = await this.deps.repository.create(tenantId, {
      document: failed.document,
      header: { extractionErrorCode: code },
      artifact,
    });
    if (!result.created) return { created: false, document: result.document, events: [] };
    return {
      created: true,
      document: result.document,
      events: failed.event === null ? [] : [failed.event],
    };
  }
}

/** Plain machine code for a parser failure, or null for an error that is not the input's fault. */
function extractionErrorCode(error: unknown): string | null {
  if (error instanceof MalformedSifenXmlError) return `malformed_xml.${error.code}`;
  if (error instanceof UnsupportedDocumentTypeError) return 'unsupported_document_type';
  if (error instanceof SifenXmlTooLargeError) return 'xml_too_large';
  return null;
}

function toHeader(parsed: ParsedSifenDocument): ReceivedDocumentHeaderInput {
  const { issuer, receiver, totals } = parsed;
  const vat5 = Decimal.parse(totals.vat5);
  const vat10 = Decimal.parse(totals.vat10);
  return {
    documentType: parsed.documentType,
    cdc: parsed.cdc,
    establishmentCode: parsed.establishment,
    expeditionPointCode: parsed.expeditionPoint,
    documentNumber: parsed.number,
    issuerRucBase: issuer.ruc,
    issuerRucDv: issuer.dv === null ? null : Number(issuer.dv),
    issuerLegalName: issuer.legalName,
    receiverRucBase: receiver.ruc,
    receiverRucDv: receiver.dv === null ? null : Number(receiver.dv),
    receiverLegalName: receiver.name,
    issuedAt: new Date(`${parsed.issueDate}T00:00:00.000Z`),
    paymentCondition: parsed.paymentCondition,
    creditTermDays: parsed.creditTermDays,
    currency: parsed.currency,
    totalExempt: totals.exempt,
    totalZeroRated: totals.exonerated,
    taxable5: totals.taxable5,
    taxable10: totals.taxable10,
    vat5: totals.vat5,
    vat10: totals.vat10,
    totalVat: vat5.ok && vat10.ok ? vat5.value.add(vat10.value).toString() : null,
    totalAmount: totals.total,
    totalPyg: parsed.currency === 'PYG' ? totals.total : null,
    sifenStatus: parsed.authorizationProtocol === null ? 'unknown' : 'approved',
    sifenProtocolNumber: parsed.authorizationProtocol,
    rawData: parsed,
  };
}

function toItem(item: ParsedSifenDocument['items'][number], index: number): ReceivedDocumentItem {
  return {
    position: index + 1,
    description: item.description,
    productCode: null,
    quantity: item.quantity,
    unitOfMeasure: null,
    unitPrice: item.unitPrice,
    discount: item.discount,
    subtotal: item.lineTotal,
    vatRate: item.taxRate as 0 | 5 | 10,
    taxableBase: item.taxBase,
    vatAmount: item.taxAmount,
  };
}

function toConfidence(fieldName: (typeof CONFIDENCE_FIELDS)[number]): FieldConfidence {
  return {
    fieldName,
    confidence: FULL_CONFIDENCE,
    extractedValue: null,
    correctedValue: null,
    correctedBy: null,
    correctedAt: null,
  };
}
