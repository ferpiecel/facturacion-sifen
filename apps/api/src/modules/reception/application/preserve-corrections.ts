import { RECEIVED_FIELD_NAMES, type ReceivedFieldName } from '../domain/confidence-policy.js';
import type {
  FieldConfidence,
  ReceivedDocumentGraph,
  ReceivedDocumentHeader,
  ReceivedDocumentHeaderInput,
  ReceivedDocumentItem,
} from './ports/received-document-repository.port.js';

/** Header columns each curated field owns (the same grouping as the field-level corrections). */
const FIELD_COLUMNS: Readonly<
  Record<Exclude<ReceivedFieldName, 'items'>, readonly (keyof ReceivedDocumentHeader)[]>
> = {
  issuer_ruc: ['issuerRucBase', 'issuerRucDv'],
  issuer_legal_name: ['issuerLegalName'],
  issued_on: ['issuedAt'],
  document_number: ['establishmentCode', 'expeditionPointCode', 'documentNumber'],
  receiver_ruc: ['receiverRucBase', 'receiverRucDv'],
  payment_condition: ['paymentCondition'],
  totals: [
    'totalExempt',
    'totalZeroRated',
    'taxable5',
    'taxable10',
    'vat5',
    'vat10',
    'totalVat',
    'totalDiscount',
    'totalAmount',
    'totalPyg',
  ],
};

export interface MachineExtraction {
  readonly header: ReceivedDocumentHeaderInput;
  readonly items: readonly ReceivedDocumentItem[];
  readonly confidences: readonly FieldConfidence[];
}

export interface CorrectionsPreserved {
  /** What to write: the machine output with every human-corrected value taken out. */
  readonly header: ReceivedDocumentHeaderInput;
  readonly items: readonly ReceivedDocumentItem[];
  /** True when the items are a human override: the stored rows stay exactly as they are. */
  readonly keepItems: boolean;
  readonly confidences: readonly FieldConfidence[];
  /** Curated fields whose stored value is a human correction (or review), in field order. */
  readonly preservedFields: readonly ReceivedFieldName[];
  /** The document as it will read after the write, for validation and the receiver check. */
  readonly merged: {
    readonly header: ReceivedDocumentHeader;
    readonly items: readonly ReceivedDocumentItem[];
  };
}

/**
 * Re-extraction must never overwrite what a person decided. The merge rule:
 *
 * - A curated field whose confidence row has `corrected_at` set (a correction or an explicit
 *   review) is a human override. Its header columns keep the stored value, and its confidence row
 *   keeps `corrected_value`, `corrected_by` and `corrected_at` while taking the NEW machine
 *   `confidence` and `extracted_value`, so the person can see what the model reads now.
 * - Every other field takes the new machine output, including its confidence row.
 * - `items`: when the items field is corrected, every active item stays as the person left it
 *   (edited, added or soft-removed); the machine items are discarded. Otherwise the machine items
 *   replace the active ones as in any extraction.
 * - Columns outside the eight curated fields (`rawData`, `extractionErrorCode`, ...) always come
 *   from the machine. A null CDC read by the model never erases a stored one.
 *
 * Pure: it reads the document as loaded and decides nothing about status.
 */
export function preserveCorrections(
  graph: ReceivedDocumentGraph,
  machine: MachineExtraction,
): CorrectionsPreserved {
  const stored = new Map(graph.confidences.map((row) => [row.fieldName, row]));
  const isCorrected = (field: string) => stored.get(field)?.correctedAt != null;
  const preservedFields = RECEIVED_FIELD_NAMES.filter(isCorrected);
  const keepItems = preservedFields.includes('items');

  const dropped = new Set<string>(
    preservedFields.flatMap((field) => (field === 'items' ? [] : FIELD_COLUMNS[field])),
  );
  if (preservedFields.length > 0 && machine.header.cdc === null && graph.header.cdc !== null) {
    dropped.add('cdc');
  }
  const header = Object.fromEntries(
    Object.entries(machine.header).filter(([column]) => !dropped.has(column)),
  ) as ReceivedDocumentHeaderInput;

  const confidences = machine.confidences.map((row) => {
    const previous = stored.get(row.fieldName);
    return previous?.correctedAt == null
      ? row
      : {
          ...row,
          correctedValue: previous.correctedValue,
          correctedBy: previous.correctedBy,
          correctedAt: previous.correctedAt,
        };
  });

  const items = keepItems ? graph.items : machine.items;
  return {
    header,
    items: keepItems ? [] : machine.items,
    keepItems,
    confidences,
    preservedFields,
    merged: { header: { ...graph.header, ...header }, items },
  };
}
