import { Decimal } from '../../emission/domain/decimal.js';
import {
  recordReceivedDocumentCorrection,
  transitionReceivedDocument,
  type ReceivedDocument,
} from '../domain/received-document.js';
import type { ReceivedDocumentStatus } from '../domain/received-document-status.js';
import { validateReceivedDocument } from '../domain/received-document-validation.js';
import { splitRuc } from '../domain/receiver-match.js';
import type { ReceptionEventType } from '../domain/reception-events.js';
import {
  ReceivedDocumentNotFoundError,
  VersionConflictError,
  type ConfidenceCorrectionWrite,
  type ReceivedDocumentGraph,
  type ReceivedDocumentHeader,
  type ReceivedDocumentHeaderInput,
  type ReceivedDocumentItem,
  type ReceivedDocumentRepository,
} from './ports/received-document-repository.port.js';
import { toStoredDocumentFields } from './stored-document-fields.js';

/** Header fields an ERP may correct; `null` clears a nullable field, absent keeps it. */
export interface HeaderPatch {
  readonly documentType?: number | null;
  readonly timbrado?: string | null;
  readonly establishmentCode?: string | null;
  readonly expeditionPointCode?: string | null;
  /** The 7-digit sequence of `EEE-PPP-NNNNNNN`. */
  readonly documentSequence?: string | null;
  readonly series?: string | null;
  /** ISO calendar date. */
  readonly issuedOn?: string | null;
  readonly currency?: string;
  readonly exchangeRate?: string | null;
  /** `<base>` or `<base>-<dv>`. */
  readonly issuerRuc?: string | null;
  readonly issuerLegalName?: string | null;
  readonly issuerTradeName?: string | null;
  readonly issuerAddress?: string | null;
  readonly issuerEconomicActivity?: string | null;
  readonly receiverRuc?: string | null;
  readonly receiverLegalName?: string | null;
  readonly receiverType?: number | null;
  readonly paymentCondition?: 'cash' | 'credit' | null;
  readonly creditTermDays?: number | null;
  readonly paymentMethod?: string | null;
  readonly dueOn?: string | null;
  readonly paidOn?: string | null;
  readonly totalExempt?: string | null;
  readonly totalZeroRated?: string | null;
  readonly taxable5?: string | null;
  readonly taxable10?: string | null;
  readonly vat5?: string | null;
  readonly vat10?: string | null;
  readonly totalVat?: string | null;
  readonly totalDiscount?: string | null;
  readonly totalAmount?: string | null;
  readonly totalPyg?: string | null;
}

/**
 * One line operation, addressed by `position` (chosen by the caller and never reused): an
 * existing active position is modified, a position never used is added, `remove: true` soft-removes.
 */
export interface ItemPatch {
  readonly position: number;
  readonly remove?: boolean;
  readonly description?: string | null;
  readonly productCode?: string | null;
  readonly quantity?: string | null;
  readonly unitOfMeasure?: string | null;
  readonly unitPrice?: string | null;
  readonly discount?: string | null;
  readonly subtotal?: string | null;
  readonly vatRate?: 0 | 5 | 10 | null;
  readonly taxableBase?: string | null;
  readonly vatAmount?: string | null;
}

export interface CorrectReceivedDocumentInput {
  readonly tenantId: string;
  readonly id: string;
  /** The version the caller read; the write only applies if it is still the stored one. */
  readonly expectedVersion: number;
  /** API key id (or portal user id) recorded as `corrected_by` / `confirmed_by`. */
  readonly actorId: string;
  readonly header?: HeaderPatch;
  readonly items?: readonly ItemPatch[];
  readonly confirm?: boolean;
}

export interface CorrectReceivedDocumentResult {
  readonly document: ReceivedDocument;
  /** True when the request had already been applied: nothing was written. */
  readonly replayed: boolean;
  /** Events the caller must enqueue (R4.5); empty for no-ops, replays and silent documents. */
  readonly events: readonly ReceptionEventType[];
}

export interface CorrectReceivedDocumentDeps {
  readonly repository: ReceivedDocumentRepository;
  readonly now: () => Date;
}

/** Only `needs_review` and `confirmed` documents accept a correction. */
export class InvalidReceivedDocumentStateError extends Error {
  constructor(readonly status: ReceivedDocumentStatus) {
    super(`a received document in ${status} cannot be corrected`);
    this.name = 'InvalidReceivedDocumentStateError';
  }
}

/** The patch does not make sense against the current document (bad value or item position). */
export class InvalidCorrectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCorrectionError';
  }
}

/** The corrected document would not pass the reception validations; nothing was written. */
export class ValidationFailedError extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`validation failed: ${reasons.join(', ')}`);
    this.name = 'ValidationFailedError';
  }
}

/** Reason of a `needs_review` document whose data is valid but nobody confirmed it yet. */
export const AWAITING_CONFIRMATION = 'awaiting_confirmation';

type HeaderChange = Record<string, unknown>;

const TEXT_KEYS = [
  'timbrado',
  'establishmentCode',
  'expeditionPointCode',
  'series',
  'issuerLegalName',
  'issuerTradeName',
  'issuerAddress',
  'issuerEconomicActivity',
  'receiverLegalName',
  'paymentMethod',
] as const;
const INTEGER_KEYS = ['documentType', 'receiverType', 'creditTermDays'] as const;
const DECIMAL_KEYS = [
  'exchangeRate',
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
] as const;
const DATE_KEYS = ['dueOn', 'paidOn'] as const;
const TOTAL_COLUMNS = new Set<string>(DECIMAL_KEYS.filter((key) => key !== 'exchangeRate'));
const ITEM_DECIMALS = [
  'quantity',
  'unitPrice',
  'discount',
  'subtotal',
  'taxableBase',
  'vatAmount',
] as const;
const isItemDecimal = (field: string) => (ITEM_DECIMALS as readonly string[]).includes(field);
const ITEM_FIELDS = [
  'description',
  'productCode',
  'unitOfMeasure',
  ...ITEM_DECIMALS,
  'vatRate',
] as const;
const DOCUMENT_TYPES = [1, 4, 5, 6, 7];

const bad = (message: string) => new InvalidCorrectionError(message);

function parseDecimal(label: string, value: string, integerDigits: number): Decimal {
  const parsed = Decimal.parse(value);
  if (!parsed.ok || !parsed.value.fitsIn(integerDigits, 8))
    throw bad(`${label} is not a valid amount`);
  return parsed.value;
}

function checkDate(label: string, value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || date.toISOString().slice(0, 10) !== value) {
    throw bad(`${label} is not a valid date`);
  }
  return date;
}

function sameValue(a: unknown, b: unknown, decimal: boolean): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (decimal && typeof a === 'string' && typeof b === 'string') {
    const [left, right] = [Decimal.parse(a), Decimal.parse(b)];
    return left.ok && right.ok && left.value.equals(right.value);
  }
  return a === b;
}

/** The patch as header columns (only values that differ from the stored ones). */
function headerChanges(header: ReceivedDocumentHeader, patch: HeaderPatch): HeaderChange {
  const wanted: HeaderChange = {};
  for (const key of TEXT_KEYS) if (patch[key] !== undefined) wanted[key] = patch[key];
  for (const key of INTEGER_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value !== null && !Number.isInteger(value)) throw bad(`${key} must be an integer`);
    if (key === 'documentType' && value !== null && !DOCUMENT_TYPES.includes(value)) {
      throw bad('documentType is not a supported document type');
    }
    wanted[key] = value;
  }
  for (const key of DECIMAL_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value !== null) parseDecimal(key, value, 15);
    wanted[key] = value;
  }
  for (const key of DATE_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value !== null) checkDate(key, value);
    wanted[key] = value;
  }
  if (patch.currency !== undefined) {
    if (!/^[A-Z]{3}$/.test(patch.currency)) throw bad('currency must be an ISO 4217 code');
    wanted.currency = patch.currency;
  }
  if (patch.paymentCondition !== undefined) wanted.paymentCondition = patch.paymentCondition;
  if (patch.documentSequence !== undefined) wanted.documentNumber = patch.documentSequence;
  if (patch.issuedOn !== undefined) {
    wanted.issuedAt = patch.issuedOn === null ? null : checkDate('issuedOn', patch.issuedOn);
  }
  for (const [field, base, dv] of [
    ['issuerRuc', 'issuerRucBase', 'issuerRucDv'],
    ['receiverRuc', 'receiverRucBase', 'receiverRucDv'],
  ] as const) {
    const raw = patch[field];
    if (raw === undefined) continue;
    const ruc = raw === null ? { base: null, dv: null } : splitRuc(raw);
    if (ruc === null) throw bad(`${field} is not a valid RUC`);
    wanted[base] = ruc.base;
    wanted[dv] = ruc.dv;
  }

  const stored = header as unknown as Record<string, unknown>;
  const decimal = new Set<string>(DECIMAL_KEYS);
  return Object.fromEntries(
    Object.entries(wanted).filter(
      ([key, value]) => !sameValue(stored[key], value, decimal.has(key)),
    ),
  );
}

interface ItemChanges {
  readonly upserts: ReceivedDocumentItem[];
  readonly removedPositions: number[];
  readonly added: number[];
  readonly modified: number[];
  readonly active: ReceivedDocumentItem[];
  /** Items before the change, for the audit trail. */
  readonly before: ReceivedDocumentItem[];
}

function itemChanges(graph: ReceivedDocumentGraph, patches: readonly ItemPatch[]): ItemChanges {
  const current = new Map(graph.items.map((item) => [item.position, item]));
  const removed = new Set(graph.removedPositions);
  const seen = new Set<number>();
  const out: ItemChanges = {
    upserts: [],
    removedPositions: [],
    added: [],
    modified: [],
    active: [],
    before: [],
  };
  for (const patch of patches) {
    const { position } = patch;
    if (!Number.isInteger(position) || position < 1) throw bad('item position must be >= 1');
    if (seen.has(position)) throw bad(`item position ${String(position)} appears twice`);
    seen.add(position);
    const existing = current.get(position);
    if (patch.remove === true) {
      if (ITEM_FIELDS.some((field) => patch[field] !== undefined)) {
        throw bad(`item ${String(position)} cannot be removed and edited at once`);
      }
      if (existing) out.removedPositions.push(position);
      else if (!removed.has(position)) throw bad(`item ${String(position)} does not exist`);
      continue;
    }
    if (removed.has(position))
      throw bad(`item ${String(position)} was removed; positions are not reused`);
    for (const field of ITEM_DECIMALS) {
      const value = patch[field];
      if (typeof value === 'string')
        parseDecimal(`item ${field}`, value, field === 'quantity' ? 10 : 15);
    }
    const base: ReceivedDocumentItem = existing ?? {
      position,
      description: null,
      productCode: null,
      quantity: null,
      unitOfMeasure: null,
      unitPrice: null,
      discount: null,
      subtotal: null,
      vatRate: null,
      taxableBase: null,
      vatAmount: null,
    };
    const next: Record<string, unknown> = { ...base };
    for (const field of ITEM_FIELDS) if (patch[field] !== undefined) next[field] = patch[field];
    const changed =
      existing === undefined ||
      ITEM_FIELDS.some((field) => !sameValue(base[field], next[field], isItemDecimal(field)));
    if (!changed) continue;
    out.upserts.push(next as unknown as ReceivedDocumentItem);
    (existing ? out.modified : out.added).push(position);
    if (existing) out.before.push(existing);
  }
  out.removedPositions.forEach((position) => {
    const item = current.get(position);
    if (item) out.before.push(item);
  });
  const upserted = new Map(out.upserts.map((item) => [item.position, item]));
  const gone = new Set(out.removedPositions);
  out.active.push(
    ...[...current.values()]
      .filter((item) => !gone.has(item.position))
      .map((item) => upserted.get(item.position) ?? item),
    ...out.upserts.filter((item) => !current.has(item.position)),
  );
  out.active.sort((a, b) => a.position - b.position);
  return out;
}

const CONFIDENCE_FIELDS: readonly (readonly [string, (columns: Set<string>) => boolean])[] = [
  ['issuer_ruc', (c) => c.has('issuerRucBase') || c.has('issuerRucDv')],
  ['issuer_legal_name', (c) => c.has('issuerLegalName')],
  ['issued_on', (c) => c.has('issuedAt')],
  [
    'document_number',
    (c) => c.has('establishmentCode') || c.has('expeditionPointCode') || c.has('documentNumber'),
  ],
  ['receiver_ruc', (c) => c.has('receiverRucBase') || c.has('receiverRucDv')],
  ['payment_condition', (c) => c.has('paymentCondition')],
  ['totals', (c) => [...c].some((key) => TOTAL_COLUMNS.has(key))],
];

function confidenceCorrections(
  merged: ReceivedDocumentHeader,
  changes: HeaderChange,
  items: ItemChanges,
): ConfidenceCorrectionWrite[] {
  const columns = new Set(Object.keys(changes));
  const ruc = (base: string | null, dv: number | null): string | null =>
    base === null ? null : dv === null ? base : `${base}-${String(dv)}`;
  const values: Record<string, string | null> = {
    issuer_ruc: ruc(merged.issuerRucBase, merged.issuerRucDv),
    issuer_legal_name: merged.issuerLegalName,
    issued_on: merged.issuedAt?.toISOString().slice(0, 10) ?? null,
    document_number: [merged.establishmentCode, merged.expeditionPointCode, merged.documentNumber]
      .filter((part): part is string => part !== null)
      .join('-'),
    receiver_ruc: ruc(merged.receiverRucBase, merged.receiverRucDv),
    payment_condition: merged.paymentCondition,
    totals: JSON.stringify(
      Object.fromEntries(Object.entries(changes).filter(([key]) => TOTAL_COLUMNS.has(key))),
    ),
  };
  const out = CONFIDENCE_FIELDS.filter(([, touched]) => touched(columns)).map(([fieldName]) => ({
    fieldName,
    correctedValue: values[fieldName],
  }));
  if (items.upserts.length > 0 || items.removedPositions.length > 0) {
    out.push({
      fieldName: 'items',
      correctedValue: JSON.stringify({
        added: items.added,
        modified: items.modified,
        removed: items.removedPositions,
      }),
    });
  }
  return out;
}

const snapshot = (changes: HeaderChange, source: object): HeaderChange =>
  Object.fromEntries(
    Object.keys(changes).map((key) => [key, (source as Record<string, unknown>)[key] ?? null]),
  );

/**
 * Corrects header fields and items of a received document and, optionally, confirms it, in one
 * call (reception R4.4). Rules:
 * - only `needs_review` and `confirmed` documents accept it;
 * - the caller's `expectedVersion` must be the stored version, else {@link VersionConflictError};
 * - a request that is already reflected by the stored data is a no-op, never a second write: at
 *   the current version it changes nothing; at the previous version, from the same actor, it is
 *   an idempotent replay of the request that produced the current version;
 * - the resulting document is revalidated whenever it ends `confirmed`; a failure rejects the
 *   WHOLE request (corrections are not persisted), see {@link ValidationFailedError};
 * - a correction that does not confirm moves a `needs_review` document's version and refreshes
 *   its reasons (`awaiting_confirmation` when the data is valid but unconfirmed);
 * - every applied request writes one audit entry in the same transaction.
 */
export function createCorrectReceivedDocument(deps: CorrectReceivedDocumentDeps) {
  return async function correctReceivedDocument(
    input: CorrectReceivedDocumentInput,
  ): Promise<CorrectReceivedDocumentResult> {
    const { tenantId, id, actorId, expectedVersion } = input;
    const graph = await deps.repository.load(tenantId, id);
    if (graph === null) throw new ReceivedDocumentNotFoundError(id);
    const { document } = graph;
    if (document.status !== 'needs_review' && document.status !== 'confirmed') {
      throw new InvalidReceivedDocumentStateError(document.status);
    }
    const conflict = () => new VersionConflictError(id, expectedVersion, document.version);
    if (expectedVersion > document.version || expectedVersion < document.version - 1) {
      throw conflict();
    }

    const confirm = input.confirm === true;
    const changes = headerChanges(graph.header, input.header ?? {});
    const items = itemChanges(graph, input.items ?? []);
    const unchanged =
      Object.keys(changes).length === 0 &&
      items.upserts.length === 0 &&
      items.removedPositions.length === 0 &&
      (!confirm || document.status === 'confirmed');

    if (expectedVersion === document.version - 1) {
      const sameActor =
        graph.header.correctedBy === actorId || graph.header.confirmedBy === actorId;
      if (unchanged && sameActor) return { document, replayed: true, events: [] };
      throw conflict();
    }
    if (unchanged) return { document, replayed: false, events: [] };

    const at = deps.now();
    const merged = { ...graph.header, ...changes };
    const reasons = validateReceivedDocument(toStoredDocumentFields(merged, items.active));
    const ends = confirm || document.status === 'confirmed' ? 'confirmed' : 'needs_review';

    let next: ReceivedDocument;
    let event: ReceptionEventType | null = null;
    if (ends === 'confirmed') {
      if (reasons.length > 0) throw new ValidationFailedError(reasons);
      const result = transitionReceivedDocument(document, 'confirmed', { at });
      next = result.document;
      event = result.event;
    } else {
      next = recordReceivedDocumentCorrection(
        document,
        reasons.length > 0 ? reasons : [AWAITING_CONFIRMATION],
      );
    }

    const edited =
      Object.keys(changes).length > 0 || items.upserts.length + items.removedPositions.length > 0;
    const header: ReceivedDocumentHeaderInput = {
      ...changes,
      ...(edited ? { correctedBy: actorId, correctedAt: at } : {}),
      ...(document.status === 'needs_review' && ends === 'confirmed'
        ? { confirmedBy: actorId }
        : {}),
    };
    const confirmedNow = document.status === 'needs_review' && ends === 'confirmed';
    await deps.repository.saveCorrection(tenantId, {
      document: next,
      expectedVersion: document.version,
      header,
      items: { upserts: items.upserts, removedPositions: items.removedPositions },
      confidences: confidenceCorrections(merged, changes, items),
      actorId,
      at,
      audit: {
        action: confirmedNow ? 'received_document.confirmed' : 'received_document.corrected',
        before: {
          status: document.status,
          version: document.version,
          header: snapshot(changes, graph.header),
          items: items.before,
        },
        after: {
          status: next.status,
          version: next.version,
          header: snapshot(changes, merged),
          items: { upserted: items.upserts, removed: items.removedPositions },
        },
      },
    });
    return { document: next, replayed: false, events: event === null ? [] : [event] };
  };
}
