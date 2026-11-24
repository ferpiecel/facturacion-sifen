import { Decimal } from '../../emission/domain/decimal.js';
import {
  decideExtractionOutcome,
  type ConfidencePolicy,
  type ReceivedFieldName,
} from '../domain/confidence-policy.js';
import { createCdcReference } from '../domain/cdc-reference.js';
import {
  EXTRACTION_MAX_TEXT_CHARS,
  EXTRACTION_PROMPT_VERSION,
} from '../domain/extraction-prompt.js';
import { parseLlmExtractionOutput } from '../domain/extraction-output-schema.js';
import {
  hasUnverifiableItems,
  toReceivedDocumentFields,
  type ExtractionResult,
} from '../domain/extraction-result.js';
import {
  rehydrateReceivedDocument,
  transitionReceivedDocument,
  type ReceivedDocument,
} from '../domain/received-document.js';
import { validateReceivedDocument } from '../domain/received-document-validation.js';
import { matchReceiver, splitRuc } from '../domain/receiver-match.js';
import type { ReceptionEventType } from '../domain/reception-events.js';
import { imageMediaType, sniffUpload } from '../domain/upload-sniff.js';
import {
  ExtractionLlmDisabledError,
  ExtractionLlmInvalidOutputError,
  ExtractionLlmProviderError,
  ExtractionLlmRateLimitedError,
  ExtractionLlmRefusalError,
  type ExtractionLlm,
  type ExtractionPageImage,
} from './ports/extraction-llm.port.js';
import {
  CorruptPdfError,
  EmptyPdfError,
  TooManyPagesError,
  type PdfRenderer,
} from './ports/pdf-renderer.port.js';
import type { QrDecoder } from './ports/qr-decoder.port.js';
import {
  VersionConflictError,
  type FieldConfidence,
  type ReceivedDocumentGraph,
  type ReceivedDocumentHeaderInput,
  type ReceivedDocumentItem,
  type ReceivedDocumentRepository,
  type ReceptionEventRequest,
} from './ports/received-document-repository.port.js';
import { StorageObjectNotFoundError, type StorageProvider } from './ports/storage-provider.port.js';
import { preserveCorrections } from './preserve-corrections.js';
import { toStoredDocumentFields } from './stored-document-fields.js';
import type { TenantFiscalIdentity } from './ports/tenant-fiscal-identity.port.js';

/** Page cap and render resolution of project A (`ingesta_extraccion.py`); overridable per call. */
export const EXTRACTION_MAX_PAGES = 5;
export const EXTRACTION_DPI = 200;
/** Hard cap: a PDF with more pages is refused before any page is read (page bomb). */
export const EXTRACTION_MAX_PDF_PAGES = 50;

export interface ExtractReceivedDocumentDeps {
  readonly repository: ReceivedDocumentRepository;
  readonly storage: StorageProvider;
  readonly pdfRenderer: PdfRenderer;
  readonly qrDecoder: QrDecoder;
  readonly llm: ExtractionLlm;
  readonly fiscalIdentity: TenantFiscalIdentity;
  /** Built once from `RECEPTION_AUTO_CONFIRM_THRESHOLD` by the module wiring. */
  readonly policy: ConfidencePolicy;
  readonly now: () => Date;
}

export interface ExtractReceivedDocumentInput {
  readonly tenantId: string;
  readonly documentId: string;
  /** 1-based number of this run of the job. A value above 1 lets it resume a crashed attempt. */
  readonly attempt?: number;
  /**
   * False while the queue will still retry a retryable failure: the document is marked failed (it
   * is reprocessable) but no webhook goes out until the failure is final. Defaults to true.
   */
  readonly finalAttempt?: boolean;
  /**
   * The job comes from a reprocess request (R5.8b): it may take a `needs_review` or `confirmed`
   * document back into extraction, keeping its human corrections. Any other job leaves such a
   * document alone (`already_processed`).
   */
  readonly reprocess?: boolean;
  readonly options?: { readonly maxPages?: number; readonly dpi?: number };
}

/** Stable machine codes stored in `extraction_error_code`; never provider text. */
export type ExtractionFailureCode =
  | 'artifact_missing'
  | 'unsupported_source'
  | 'corrupt_pdf'
  | 'empty_pdf'
  | 'too_many_pages'
  | 'llm_disabled'
  | 'llm_refusal'
  | 'llm_invalid_output'
  | 'llm_provider_error'
  | 'llm_rate_limited'
  | 'duplicate_document'
  | 'internal_error';

export type ExtractSkipReason =
  'not_found' | 'not_vision_source' | 'already_processed' | 'in_progress';

export type ExtractReceivedDocumentResult =
  /** Nothing was done; the job is complete (a duplicate or stale job). */
  | { readonly kind: 'skipped'; readonly reason: ExtractSkipReason }
  | {
      readonly kind: 'extracted';
      readonly status: 'confirmed' | 'needs_review';
      readonly document: ReceivedDocument;
      readonly events: readonly ReceptionEventType[];
    }
  /** The document is `extraction_failed`; `retryable` tells the queue whether to run the job again. */
  | {
      readonly kind: 'failed';
      readonly code: ExtractionFailureCode;
      readonly retryable: boolean;
      readonly retryAfterSeconds: number | null;
      readonly document: ReceivedDocument;
      /** The original error, for the caller to log (names only, never content). */
      readonly cause?: unknown;
    };

interface Failure {
  readonly code: ExtractionFailureCode;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;
  readonly cause?: unknown;
}

/** Thrown inside a run for a failure that is already classified. */
class ExtractionFailed extends Error {
  constructor(readonly failure: Failure) {
    super(failure.code);
  }
}

const fail = (code: ExtractionFailureCode, retryable = false): ExtractionFailed =>
  new ExtractionFailed({ code, retryable, retryAfterSeconds: null });

function classify(error: unknown): Failure {
  if (error instanceof ExtractionFailed) return error.failure;
  const base = { retryAfterSeconds: null };
  if (error instanceof CorruptPdfError) return { ...base, code: 'corrupt_pdf', retryable: false };
  if (error instanceof EmptyPdfError) return { ...base, code: 'empty_pdf', retryable: false };
  if (error instanceof TooManyPagesError) {
    return { ...base, code: 'too_many_pages', retryable: false };
  }
  if (error instanceof StorageObjectNotFoundError) {
    return { ...base, code: 'artifact_missing', retryable: false };
  }
  if (error instanceof ExtractionLlmDisabledError) {
    return { ...base, code: 'llm_disabled', retryable: false };
  }
  if (error instanceof ExtractionLlmRefusalError) {
    return { ...base, code: 'llm_refusal', retryable: false };
  }
  if (error instanceof ExtractionLlmInvalidOutputError) {
    return { ...base, code: 'llm_invalid_output', retryable: false };
  }
  if (error instanceof ExtractionLlmProviderError) {
    return { ...base, code: 'llm_provider_error', retryable: error.retryable };
  }
  if (error instanceof ExtractionLlmRateLimitedError) {
    return {
      code: 'llm_rate_limited',
      retryable: true,
      retryAfterSeconds: error.retryAfterSeconds,
    };
  }
  return { ...base, code: 'internal_error', retryable: true, cause: error };
}

interface Pages {
  readonly pages: readonly ExtractionPageImage[];
  readonly pdfText: string | null;
  readonly pageCount: number;
}

type Claim =
  | { readonly kind: 'claimed'; readonly document: ReceivedDocument }
  | { readonly kind: 'skipped'; readonly reason: ExtractSkipReason };

/**
 * Worker-side extraction of a PDF or photo (reception R5.6a). Loads the stored upload, renders it,
 * asks the vision model, validates the answer and persists the outcome with the same events as the
 * XML path. It never throws for a document-level failure: that becomes `extraction_failed`, and the
 * returned `retryable` flag tells the queue whether another run can help. Only infrastructure
 * errors while persisting the outcome propagate.
 *
 * State machine: `received -> extracting` (claim) then one atomic write of `extracted` and its
 * follow-up (`confirmed` or `needs_review`), or `extracting -> extraction_failed`. A failed document
 * is picked up again by a retry or a reprocess. The claim does not bump the version (worker-driven
 * progress), so two workers racing on one document are possible; the job id derived from the
 * document id and the per-tenant concurrency cap (R5.9) keep that window small, and every write is
 * idempotent.
 */
export class ExtractReceivedDocument {
  constructor(private readonly deps: ExtractReceivedDocumentDeps) {}

  async execute(input: ExtractReceivedDocumentInput): Promise<ExtractReceivedDocumentResult> {
    const { tenantId, documentId } = input;
    const graph = await this.deps.repository.load(tenantId, documentId);
    if (graph === null) return { kind: 'skipped', reason: 'not_found' };
    if (graph.document.source !== 'pdf' && graph.document.source !== 'photo') {
      return { kind: 'skipped', reason: 'not_vision_source' };
    }
    const claim = await this.claim(tenantId, graph.document, input);
    if (claim.kind === 'skipped') return claim;

    try {
      return await this.run(tenantId, graph, claim.document, input);
    } catch (error) {
      return this.persistFailure(tenantId, claim.document, classify(error), input);
    }
  }

  /**
   * Last resort for the FINAL attempt of a job that threw an unexpected error (an infrastructure
   * failure while loading, claiming or persisting): moves a document left in `received` or
   * `extracting` to `extraction_failed` with the stable code `internal_error` and the failure event,
   * so it is never stuck. Stores no error text. Anything already processed (or unknown) is left alone.
   * It may itself fail (the database that broke the run may still be down); the caller handles that.
   */
  async failUnexpected(input: { readonly tenantId: string; readonly documentId: string }) {
    const { tenantId, documentId } = input;
    const graph = await this.deps.repository.load(tenantId, documentId);
    if (graph === null) return;
    const { document } = graph;
    if (document.status !== 'received' && document.status !== 'extracting') return;
    const extracting =
      document.status === 'extracting'
        ? document
        : transitionReceivedDocument(document, 'extracting', { at: this.deps.now() }).document;
    await this.persistFailure(
      tenantId,
      extracting,
      { code: 'internal_error', retryable: false, retryAfterSeconds: null },
      { tenantId, documentId, finalAttempt: true },
    );
  }

  private async claim(
    tenantId: string,
    document: ReceivedDocument,
    input: ExtractReceivedDocumentInput,
  ): Promise<Claim> {
    if (document.status === 'extracting') {
      // Another worker is on it, unless this is a retry after that attempt crashed.
      return (input.attempt ?? 1) > 1
        ? { kind: 'claimed', document }
        : { kind: 'skipped', reason: 'in_progress' };
    }
    const reviewed = document.status === 'needs_review' || document.status === 'confirmed';
    if (
      document.status !== 'received' &&
      document.status !== 'extraction_failed' &&
      !(reviewed && input.reprocess === true)
    ) {
      return { kind: 'skipped', reason: 'already_processed' };
    }
    const extracting = transitionReceivedDocument(document, 'extracting', {
      at: this.deps.now(),
    }).document;
    try {
      await this.deps.repository.save(tenantId, extracting, document.version);
    } catch (error) {
      if (error instanceof VersionConflictError) return { kind: 'skipped', reason: 'in_progress' };
      throw error;
    }
    return { kind: 'claimed', document: extracting };
  }

  private async run(
    tenantId: string,
    graph: ReceivedDocumentGraph,
    extracting: ReceivedDocument,
    input: ExtractReceivedDocumentInput,
  ): Promise<ExtractReceivedDocumentResult> {
    if (graph.artifact === null) throw fail('artifact_missing');
    const bytes = await this.deps.storage.download(graph.artifact.storageKey);
    const { pages, pdfText, pageCount } = await this.loadPages(graph, bytes, input);
    const cdcHint = await this.readCdcHint(pages[0]);

    const response = await this.deps.llm.extract({ pages, pdfText, cdcHint });
    const parsed = parseLlmExtractionOutput(response.rawText);
    if (!parsed.ok) throw fail('llm_invalid_output');
    const { result, notes } = parsed.value;

    const fields = toReceivedDocumentFields(result);
    const machineReasons = validateReceivedDocument(fields);
    const cdc =
      fields.cdc !== null && !machineReasons.some((r) => r.startsWith('cdc_')) ? fields.cdc : null;
    if (cdc !== null) {
      const existing = await this.deps.repository.findByCdc(tenantId, cdc);
      if (existing !== null && existing.id !== extracting.id) throw fail('duplicate_document');
    }

    // A re-extraction keeps what a person corrected; the decision below reads the merged data.
    const kept = preserveCorrections(graph, {
      header: toHeader(result, cdc, {
        notes,
        modelId: response.modelId,
        pageCount,
        pagesSent: pages.length,
        issueDateValid: !machineReasons.includes('invalid_issue_date'),
      }),
      items: result.items.map(toItem),
      confidences: toConfidences(result),
    });
    const merged = kept.preservedFields.length > 0 ? kept.merged : null;
    const reasons =
      merged === null
        ? machineReasons
        : validateReceivedDocument(toStoredDocumentFields(merged.header, merged.items));

    const identity = await this.deps.fiscalIdentity.getRucIdentity(tenantId);
    // Like the XML path: what cannot be proven to be the tenant's is not own (and webhook-silent).
    const receiverRuc =
      merged === null
        ? result.receiverRuc
        : rucText(merged.header.receiverRucBase, merged.header.receiverRucDv);
    const isOwnReceiver = identity !== null && matchReceiver(receiverRuc, identity) === 'match';
    const decision = decideExtractionOutcome(this.deps.policy, {
      overallConfidence: result.overallConfidence,
      validationReasons: reasons,
      issuerRuc:
        merged === null
          ? result.issuerRuc
          : rucText(merged.header.issuerRucBase, merged.header.issuerRucDv),
      issuerLegalName: merged === null ? result.issuerLegalName : merged.header.issuerLegalName,
      unverifiableItems:
        merged === null
          ? hasUnverifiableItems(result)
          : merged.items.length > 0 && merged.items.every((item) => item.subtotal === null),
    });

    const at = this.deps.now();
    const base = rehydrateReceivedDocument({ ...extracting, isOwnReceiver });
    const extracted = transitionReceivedDocument(base, 'extracted', {
      at,
      confidenceOverall: result.overallConfidence.toFixed(3),
    }).document;
    const final =
      decision.status === 'confirmed'
        ? transitionReceivedDocument(extracted, 'confirmed', { at })
        : transitionReceivedDocument(extracted, 'needs_review', {
            at,
            reasons: decision.reasons,
          });

    await this.deps.repository.saveExtraction(tenantId, {
      document: final.document,
      expectedVersion: extracting.version,
      header: kept.header,
      items: kept.items,
      keepItems: kept.keepItems,
      confidences: kept.confidences,
      ...(final.event === null ? {} : { events: { types: [final.event], at } }),
    });
    return {
      kind: 'extracted',
      status: decision.status,
      document: final.document,
      events: final.event === null ? [] : [final.event],
    };
  }

  private async loadPages(
    graph: ReceivedDocumentGraph,
    bytes: Uint8Array,
    input: ExtractReceivedDocumentInput,
  ): Promise<Pages> {
    if (graph.document.source === 'pdf') {
      if (sniffUpload(bytes) !== 'pdf') throw fail('unsupported_source');
      const { pdfRenderer } = this.deps;
      const pageCount = await pdfRenderer.countPages(bytes);
      if (pageCount > EXTRACTION_MAX_PDF_PAGES) {
        throw new TooManyPagesError(pageCount, EXTRACTION_MAX_PDF_PAGES);
      }
      const maxPages = input.options?.maxPages ?? EXTRACTION_MAX_PAGES;
      const text = await pdfRenderer.extractText(bytes, {
        maxPages,
        maxChars: EXTRACTION_MAX_TEXT_CHARS,
      });
      const rendered = await pdfRenderer.rasterize(bytes, {
        maxPages,
        dpi: input.options?.dpi ?? EXTRACTION_DPI,
        overflow: 'truncate',
      });
      return {
        pages: rendered.map((page) => ({ bytes: page, mediaType: 'image/png' as const })),
        pdfText: text.trim() === '' ? null : text,
        pageCount,
      };
    }
    const mediaType = imageMediaType(bytes);
    if (mediaType === null) throw fail('unsupported_source');
    return { pages: [{ bytes, mediaType }], pdfText: null, pageCount: 1 };
  }

  /** The QR is a deterministic hint: a failure or an unverifiable CDC just means no hint. */
  private async readCdcHint(first: ExtractionPageImage | undefined): Promise<string | null> {
    if (first === undefined) return null;
    try {
      const found = await this.deps.qrDecoder.decodeCdc(first.bytes);
      return found === null ? null : createCdcReference(found).value;
    } catch {
      return null; // includes CdcReferenceError: a hint that does not verify is dropped
    }
  }

  private async persistFailure(
    tenantId: string,
    extracting: ReceivedDocument,
    failure: Failure,
    input: ExtractReceivedDocumentInput,
  ): Promise<ExtractReceivedDocumentResult> {
    const at = this.deps.now();
    const failed = transitionReceivedDocument(extracting, 'extraction_failed', { at });
    const retryComing = failure.retryable && input.finalAttempt === false;
    const events: ReceptionEventRequest | undefined =
      failed.event === null || retryComing ? undefined : { types: [failed.event], at };
    await this.deps.repository.save(tenantId, failed.document, extracting.version, {
      header: { extractionErrorCode: failure.code },
      ...(events === undefined ? {} : { events }),
    });
    return {
      kind: 'failed',
      code: failure.code,
      retryable: failure.retryable,
      retryAfterSeconds: failure.retryAfterSeconds,
      document: failed.document,
      ...(failure.cause === undefined ? {} : { cause: failure.cause }),
    };
  }
}

/** `base-dv` as the model reads a RUC, from the stored columns. */
function rucText(base: string | null, dv: number | null): string | null {
  return base === null ? null : dv === null ? base : `${base}-${String(dv)}`;
}

const DOCUMENT_NUMBER = /^(\d{3})-(\d{3})-(\d{7})$/;

interface RawMeta {
  readonly notes: string;
  readonly modelId: string;
  readonly pageCount: number;
  readonly pagesSent: number;
  readonly issueDateValid: boolean;
}

function sum(...values: readonly string[]): string | null {
  const zero = Decimal.parse('0');
  if (!zero.ok) return null;
  let acc = zero.value;
  for (const value of values) {
    const parsed = Decimal.parse(value);
    if (!parsed.ok) return null;
    acc = acc.add(parsed.value);
  }
  return acc.toString();
}

function toHeader(
  result: ExtractionResult,
  cdc: string | null,
  meta: RawMeta,
): ReceivedDocumentHeaderInput {
  const issuer = splitRuc(result.issuerRuc);
  const receiver = splitRuc(result.receiverRuc);
  const number =
    result.documentNumber === null ? null : DOCUMENT_NUMBER.exec(result.documentNumber);
  const { totals } = result;
  return {
    cdc,
    establishmentCode: number?.[1] ?? null,
    expeditionPointCode: number?.[2] ?? null,
    documentNumber: number?.[3] ?? null,
    issuerRucBase: issuer?.base ?? null,
    issuerRucDv: issuer?.dv ?? null,
    issuerLegalName: result.issuerLegalName,
    receiverRucBase: receiver?.base ?? null,
    receiverRucDv: receiver?.dv ?? null,
    issuedAt:
      result.issueDate !== null && meta.issueDateValid
        ? new Date(`${result.issueDate}T00:00:00.000Z`)
        : null,
    paymentCondition: result.paymentCondition,
    ...(totals === null
      ? {}
      : {
          totalExempt: totals.exempt,
          totalZeroRated: totals.exonerated,
          taxable5: totals.taxable5,
          taxable10: totals.taxable10,
          vat5: totals.vat5,
          vat10: totals.vat10,
          totalVat: sum(totals.vat5, totals.vat10),
          totalAmount: totals.total,
          // The extraction carries no currency: documents are taken as PYG (the column default).
          totalPyg: totals.total,
        }),
    sifenStatus: 'unknown',
    extractionErrorCode: null,
    rawData: {
      source: 'vision',
      promptVersion: EXTRACTION_PROMPT_VERSION,
      modelId: meta.modelId,
      pageCount: meta.pageCount,
      pagesSent: meta.pagesSent,
      notes: meta.notes,
      result,
    },
  };
}

function toItem(item: ExtractionResult['items'][number], index: number): ReceivedDocumentItem {
  return { position: index + 1, ...item };
}

function confidenceText(value: number): string {
  return value.toFixed(3);
}

function toConfidences(result: ExtractionResult): FieldConfidence[] {
  const values: Record<ReceivedFieldName, string | null> = {
    issuer_ruc: result.issuerRuc,
    issuer_legal_name: result.issuerLegalName,
    issued_on: result.issueDate,
    document_number: result.documentNumber,
    receiver_ruc: result.receiverRuc,
    payment_condition: result.paymentCondition,
    totals: result.totals === null ? null : JSON.stringify(result.totals),
    items: null,
  };
  return (Object.keys(values) as ReceivedFieldName[]).map((fieldName) => ({
    fieldName,
    confidence: confidenceText(result.fieldConfidences[fieldName]),
    extractedValue: values[fieldName],
    correctedValue: null,
    correctedBy: null,
    correctedAt: null,
  }));
}
