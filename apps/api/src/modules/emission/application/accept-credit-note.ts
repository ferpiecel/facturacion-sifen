import { buildCdc } from '../domain/cdc.js';
import {
  validateCreditNoteDraft,
  validateDebitNoteDraft,
  type CreditNoteDraft,
  type NoteKind,
} from '../domain/credit-note-draft.js';
import type { ValidationConfig } from '../domain/invoice-draft.js';
import { invoiceTotals } from '../domain/invoice-totals.js';
import { requestHash } from '../domain/request-hash.js';
import { generateSecurityCode, type RandomBytes } from '../domain/security-code.js';
import type { AuditEntry } from '../../audit/application/ports/record-audit.port.js';
import {
  IdempotencyKeyReusedError,
  InvoiceValidationError,
  IssuerNotConfiguredError,
  assertCertificateUsable,
  paraguayDate,
  type AcceptedInvoice,
} from './accept-invoice.js';
import {
  IdempotencyKeyCollisionError,
  type AcceptanceUnitOfWork,
} from './ports/acceptance-unit-of-work.port.js';

/** iTiDE of each note: 5 for an NCE, 6 for an NDE. */
const NOTE_DOCUMENT_TYPE: Record<NoteKind, number> = { credit: 5, debit: 6 };
const NORMAL_EMISSION = 1; // iTipEmi

export interface AcceptCreditNoteInput {
  tenantId: string;
  actor: AuditEntry['actor'];
  establishmentCode: string;
  expeditionPointCode: string;
  draft: CreditNoteDraft;
  /** The request body as received. */
  payload: unknown;
  idempotencyKey: string;
}

export interface AcceptCreditNoteDependencies {
  unitOfWork: AcceptanceUnitOfWork;
  now?: () => Date;
  randomBytes?: RandomBytes;
  validation?: ValidationConfig;
  certificateBlockDays?: number;
  /** `credit` (NCE, the default) or `debit` (NDE, HU-E7-02: no 2417 sum, type 6). */
  kind?: NoteKind;
}

/**
 * Accepts an NCE (HU-E7-01, ADR-0019): inside one tenant transaction it finds the associated FE
 * locking its row (`FOR NO KEY UPDATE`), sums the credits that still count, validates the draft
 * against both, and only then takes the next type 5 number, so a refusal burns none and two NCEs
 * of the same FE are serialized. Idempotent like `acceptInvoice`; the receiver is the FE's.
 *
 * @throws InvoiceValidationError (with the credit note rule), IssuerNotConfiguredError,
 *   IdempotencyKeyReusedError
 */
export function createAcceptCreditNote(deps: AcceptCreditNoteDependencies) {
  const now = deps.now ?? (() => new Date());
  const kind = deps.kind ?? 'credit';
  const documentType = NOTE_DOCUMENT_TYPE[kind];

  return async function acceptCreditNote(input: AcceptCreditNoteInput): Promise<AcceptedInvoice> {
    const hash = requestHash(input.payload);
    try {
      return await acceptOnce(input, hash);
    } catch (error) {
      if (!(error instanceof IdempotencyKeyCollisionError)) throw error;
      return acceptOnce(input, hash);
    }
  };

  async function acceptOnce(input: AcceptCreditNoteInput, hash: string): Promise<AcceptedInvoice> {
    const issuedAt = now();
    const issueDate = paraguayDate(issuedAt);

    return deps.unitOfWork.run(input.tenantId, async (unit) => {
      const existing = await unit.findByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        if (existing.requestHash !== hash) throw new IdempotencyKeyReusedError();
        return { documentId: existing.documentId, cdc: existing.cdc };
      }

      const issuer = await unit.resolveIssuer({
        establishmentCode: input.establishmentCode,
        expeditionPointCode: input.expeditionPointCode,
        issueDate,
      });
      if (!issuer) throw new IssuerNotConfiguredError();
      assertCertificateUsable(issuer, issuedAt, deps.certificateBlockDays);

      const { associatedCdc } = input.draft;
      const invoice = await unit.findAssociatedInvoice(associatedCdc, issuer.environment);
      // A parallel request with the same key may have committed while this one waited for the lock.
      const replay = await unit.findByIdempotencyKey(input.idempotencyKey);
      if (replay) {
        if (replay.requestHash !== hash) throw new IdempotencyKeyReusedError();
        return { documentId: replay.documentId, cdc: replay.cdc };
      }
      // Only credit notes count against the FE total (2417); a debit adds to it.
      const creditedAmount =
        invoice && kind === 'credit'
          ? await unit.sumCreditNotes(associatedCdc, issuer.environment)
          : '0';
      const validate = kind === 'credit' ? validateCreditNoteDraft : validateDebitNoteDraft;
      const errors = validate(
        input.draft,
        invoice ? { ...invoice, creditedAmount } : undefined,
        deps.validation ?? {},
      );
      if (errors.length > 0) throw new InvoiceValidationError(errors);

      const { series, number } = await unit.nextNumber(issuer, documentType);
      const securityCode = generateSecurityCode(number, deps.randomBytes);
      const cdc = buildCdc({
        documentType: String(documentType).padStart(2, '0'),
        rucBase: issuer.rucBase,
        rucDv: issuer.rucDv,
        establishment: input.establishmentCode,
        point: input.expeditionPointCode,
        documentNumber: String(number),
        taxpayerType: issuer.taxpayerType,
        issueDate,
        emissionType: NORMAL_EMISSION,
        securityCode,
      });

      const { id } = await unit.insertDocument({
        environment: issuer.environment,
        cdc,
        documentType,
        timbradoId: issuer.timbradoId,
        establishmentId: issuer.establishmentId,
        expeditionPointId: issuer.expeditionPointId,
        series: series ?? '',
        number,
        securityCode,
        receiverRuc: invoice?.receiverRuc ?? null,
        issuedAt,
        totalAmount: invoiceTotals(input.draft).net.toString(),
        currency: 'PYG',
        payload: input.payload,
        associatedCdc,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
      });
      await unit.recordAudit({
        actor: input.actor,
        action: 'document.accepted',
        entity: { type: 'document', id },
        before: null,
        after: { cdc, status: 'accepted', associatedCdc },
      });
      return { documentId: id, cdc };
    });
  }
}

/** Accepts an NDE (HU-E7-02): the NCE flow with type 6 and without the 2417 sum. */
export function createAcceptDebitNote(deps: Omit<AcceptCreditNoteDependencies, 'kind'>) {
  return createAcceptCreditNote({ ...deps, kind: 'debit' });
}
