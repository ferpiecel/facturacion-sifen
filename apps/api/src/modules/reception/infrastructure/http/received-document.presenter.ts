import type {
  ReceivedDocumentDetail,
  ReceivedDocumentSummary,
  ReceivedDocumentSummaryHeader,
} from '../../application/ports/received-document-query.port.js';

/**
 * The only place where the wire names of the received-document read model live. The names are
 * final since R4.4 (PATCH takes the same nested shape) and the OpenAPI schemas mirror this file.
 *
 * Money and quantities are decimal strings with trailing zeros trimmed ('10.50000000' -> '10.5').
 * Storage keys, buckets, endpoints and the raw parsed payload are never exposed.
 */

const decimal = (value: string | null): string | null =>
  value === null ? null : value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

const isoDay = (date: Date | null): string | null =>
  date === null ? null : date.toISOString().slice(0, 10);

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

function ruc(base: string | null, dv: number | null): string | null {
  if (base === null) return null;
  return dv === null ? base : `${base}-${String(dv)}`;
}

function documentNumber(header: ReceivedDocumentSummaryHeader): string | null {
  const { establishmentCode, expeditionPointCode, documentNumber: sequence } = header;
  return establishmentCode && expeditionPointCode && sequence
    ? `${establishmentCode}-${expeditionPointCode}-${sequence}`
    : null;
}

export function presentReceivedDocumentSummary(item: ReceivedDocumentSummary) {
  const { document, header } = item;
  return {
    id: document.id,
    status: document.status,
    source: document.source,
    version: document.version,
    needs_review: document.needsReview,
    is_own_receiver: document.isOwnReceiver,
    document_type: header.documentType,
    cdc: header.cdc,
    issuer: { ruc: ruc(header.issuerRucBase, header.issuerRucDv), name: header.issuerLegalName },
    document_number: documentNumber(header),
    issued_on: isoDay(header.issuedAt),
    currency: header.currency,
    total_amount: decimal(header.totalAmount),
    total_vat: decimal(header.totalVat),
    confidence_overall: decimal(document.confidenceOverall),
    confirmed_at: iso(document.confirmedAt),
    has_artifact: item.hasArtifact,
    created_at: item.createdAt.toISOString(),
    updated_at: item.updatedAt.toISOString(),
  };
}

export function presentReceivedDocumentPage(page: {
  readonly items: readonly ReceivedDocumentSummary[];
  readonly nextCursor: string | null;
}) {
  return { items: page.items.map(presentReceivedDocumentSummary), next_cursor: page.nextCursor };
}

export function presentReceivedDocumentDetail(detail: ReceivedDocumentDetail) {
  const { document, header, artifact } = detail;
  return {
    id: document.id,
    status: document.status,
    source: document.source,
    version: document.version,
    needs_review: document.needsReview,
    needs_review_reasons: [...document.needsReviewReasons],
    is_own_receiver: document.isOwnReceiver,
    extraction_error_code: header.extractionErrorCode,
    extraction_attempts: document.extractionAttempts,
    confidence_overall: decimal(document.confidenceOverall),
    document_type: header.documentType,
    cdc: header.cdc,
    timbrado: header.timbrado,
    series: header.series,
    establishment_code: header.establishmentCode,
    expedition_point_code: header.expeditionPointCode,
    document_sequence: header.documentNumber,
    document_number: documentNumber(header),
    issued_on: isoDay(header.issuedAt),
    currency: header.currency,
    exchange_rate: decimal(header.exchangeRate),
    issuer: {
      ruc: ruc(header.issuerRucBase, header.issuerRucDv),
      ruc_base: header.issuerRucBase,
      ruc_dv: header.issuerRucDv,
      legal_name: header.issuerLegalName,
      trade_name: header.issuerTradeName,
      address: header.issuerAddress,
      economic_activity: header.issuerEconomicActivity,
    },
    receiver: {
      ruc: ruc(header.receiverRucBase, header.receiverRucDv),
      ruc_base: header.receiverRucBase,
      ruc_dv: header.receiverRucDv,
      legal_name: header.receiverLegalName,
      type: header.receiverType,
    },
    payment: {
      condition: header.paymentCondition,
      credit_term_days: header.creditTermDays,
      method: header.paymentMethod,
      due_on: header.dueOn,
      paid_on: header.paidOn,
    },
    totals: {
      exempt: decimal(header.totalExempt),
      zero_rated: decimal(header.totalZeroRated),
      taxable_5: decimal(header.taxable5),
      taxable_10: decimal(header.taxable10),
      vat_5: decimal(header.vat5),
      vat_10: decimal(header.vat10),
      total_vat: decimal(header.totalVat),
      discount: decimal(header.totalDiscount),
      total_amount: decimal(header.totalAmount),
      total_pyg: decimal(header.totalPyg),
    },
    sifen: {
      status: header.sifenStatus,
      authorized_at: iso(header.sifenAuthorizedAt),
      protocol_number: header.sifenProtocolNumber,
    },
    items: detail.items.map((item) => ({
      position: item.position,
      description: item.description,
      product_code: item.productCode,
      quantity: decimal(item.quantity),
      unit_of_measure: item.unitOfMeasure,
      unit_price: decimal(item.unitPrice),
      discount: decimal(item.discount),
      subtotal: decimal(item.subtotal),
      vat_rate: item.vatRate,
      taxable_base: decimal(item.taxableBase),
      vat_amount: decimal(item.vatAmount),
    })),
    field_confidences: detail.confidences.map((c) => ({
      field: c.fieldName,
      confidence: decimal(c.confidence),
      extracted_value: c.extractedValue,
      corrected_value: c.correctedValue,
      corrected_by: c.correctedBy,
      corrected_at: iso(c.correctedAt),
    })),
    confirmed_at: iso(document.confirmedAt),
    confirmed_by: header.confirmedBy,
    corrected_at: iso(header.correctedAt),
    corrected_by: header.correctedBy,
    artifact: artifact && {
      id: artifact.id,
      content_type: artifact.contentType,
      size_bytes: artifact.sizeBytes,
      sha256: artifact.sha256,
      original_name: artifact.originalName,
      page_count: artifact.pageCount,
    },
    /** Path of the authenticated stream endpoint; `.../artifact-url` returns a direct link. */
    artifact_url: artifact ? `/v1/received-documents/${document.id}/artifact` : null,
    created_at: detail.createdAt.toISOString(),
    updated_at: detail.updatedAt.toISOString(),
  };
}
