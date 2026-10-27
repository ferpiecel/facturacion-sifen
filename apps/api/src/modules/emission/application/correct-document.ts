import { classifyCorrection } from '../domain/correction-impact.js';
import type { CreditNoteDraft } from '../domain/credit-note-draft.js';
import { validateCreditNoteDraft, validateDebitNoteDraft } from '../domain/credit-note-draft.js';
import {
  validateInvoiceDraft,
  type InvoiceDraft,
  type ValidationConfig,
  type ValidationError,
} from '../domain/invoice-draft.js';
import { invoiceTotals } from '../domain/invoice-totals.js';
import { requestHash } from '../domain/request-hash.js';
import { validateSelfInvoiceDraft, type SelfInvoiceDraft } from '../domain/self-invoice-draft.js';
import { transmissionDeadline } from '../../transmission/domain/transmission-deadline.js';
import type { AuditEntry } from '../../audit/application/ports/record-audit.port.js';
import {
  IdempotencyKeyReusedError,
  type AcceptInvoiceInput,
  InvoiceValidationError,
  IssuerNotConfiguredError,
  assertCertificateUsable,
  paraguayDate,
  type AcceptedInvoice,
} from './accept-invoice.js';
import type { AcceptCreditNoteInput } from './accept-credit-note.js';
import type { AcceptSelfInvoiceInput } from './accept-standalone.js';
import { VoidRefusedError } from '../../issuer-events/application/void-numbers.js';
import { IdempotencyKeyCollisionError } from './ports/acceptance-unit-of-work.port.js';
import type {
  CorrectionUnit,
  CorrectionUnitOfWork,
  CorrectableDocument,
  StoredCorrection,
} from './ports/correction-unit-of-work.port.js';

/** iTiDE of each correctable type (ADR-0021 D5). */
const DOCUMENT_TYPE = { FE: 1, AFE: 4, NCE: 5, NDE: 6 } as const;

export type CorrectionDraft =
  | { type: 'FE'; draft: InvoiceDraft; receiverRuc: string | null }
  | { type: 'AFE'; draft: SelfInvoiceDraft }
  | { type: 'NCE' | 'NDE'; draft: CreditNoteDraft };

export class DocumentNotFoundError extends Error {
  constructor() {
    super('Document not found');
    this.name = 'DocumentNotFoundError';
  }
}

/** Only a `rejected` document is corrected (ADR-0021 D5). */
export class DocumentNotCorrectableError extends Error {
  constructor(readonly status: string) {
    super(`Only a rejected document can be corrected; this one is ${status}`);
    this.name = 'DocumentNotCorrectableError';
  }
}

/** A correction cannot turn a document into another type (ADR-0021 D4). */
export class CorrectionTypeChangedError extends Error {
  constructor() {
    super('The document type cannot change in a correction');
    this.name = 'CorrectionTypeChangedError';
  }
}

/** The document the correction left live; `voidRefused` carries the rules that refused voiding the old number. */
export type CorrectionResult = AcceptedInvoice & {
  voidRefused?: VoidRefusedError['errors'];
};

export interface CorrectDocumentInput {
  tenantId: string;
  actor: AuditEntry['actor'];
  documentId: string;
  establishmentCode: string;
  expeditionPointCode: string;
  correction: CorrectionDraft;
  /** The corrected request body as received. */
  payload: unknown;
  idempotencyKey: string;
}

/** Voids the old number of a reissued document: the E8-03 use case, seen from the emission module. */
export type VoidOldNumber = (input: {
  tenantId: string;
  actor: AuditEntry['actor'];
  body: {
    timbrado: string;
    establishment: string;
    expeditionPoint: string;
    type: number;
    series?: string;
    from: number;
    to: number;
    reason: string;
  };
  idempotencyKey: string;
}) => Promise<unknown>;

/** The normal acceptance of each correctable type, used to issue the replacement of a reissue. */
export interface ReissueAcceptors {
  FE: (input: AcceptInvoiceInput) => Promise<AcceptedInvoice>;
  AFE: (input: AcceptSelfInvoiceInput) => Promise<AcceptedInvoice>;
  NCE: (input: AcceptCreditNoteInput) => Promise<AcceptedInvoice>;
  NDE: (input: AcceptCreditNoteInput) => Promise<AcceptedInvoice>;
}

export interface CorrectDocumentDependencies {
  unitOfWork: CorrectionUnitOfWork;
  accept: ReissueAcceptors;
  voidNumbers: VoidOldNumber;
  now?: () => Date;
  validation?: ValidationConfig;
  certificateBlockDays?: number;
}

/** Document-level validation of the draft; notes need the associated FE and the 2417 sum, read in the unit. */
async function validateCorrection(
  unit: CorrectionUnit,
  input: CorrectDocumentInput,
  ownCdc: string,
  environment: 'test' | 'production',
  config: ValidationConfig,
): Promise<{ errors: ValidationError[]; receiverRuc: string | null }> {
  const { correction } = input;
  if (correction.type === 'FE') {
    return {
      errors: validateInvoiceDraft(correction.draft, config),
      receiverRuc: correction.receiverRuc,
    };
  }
  if (correction.type === 'AFE') {
    return { errors: validateSelfInvoiceDraft(correction.draft, config), receiverRuc: null };
  }
  const { associatedCdc } = correction.draft;
  const invoice = await unit.findAssociatedInvoice(associatedCdc, environment);
  // The note's own amount is not part of the credits it is checked against (ADR-0021 D5).
  const creditedAmount =
    invoice && correction.type === 'NCE'
      ? await unit.sumCreditNotes(associatedCdc, environment, ownCdc)
      : '0';
  const validate = correction.type === 'NCE' ? validateCreditNoteDraft : validateDebitNoteDraft;
  const errors = validate(
    correction.draft,
    invoice ? { ...invoice, creditedAmount } : undefined,
    config,
  );
  return { errors, receiverRuc: invoice?.receiverRuc ?? null };
}

/**
 * Corrects a `rejected` document (HU-E8-01, ADR-0021). When the correction keeps every CDC component and the
 * 72 h window of the issue date is open, the same row is rewritten and queued again with the same CDC, its previous
 * body kept in the history; otherwise the corrected body is issued as a new document and the old number is voided.
 * Idempotent through the correction's own `Idempotency-Key`.
 *
 * @throws DocumentNotFoundError, DocumentNotCorrectableError, CorrectionTypeChangedError, InvoiceValidationError, IssuerNotConfiguredError,
 *   IdempotencyKeyReusedError
 */
export function createCorrectDocument(deps: CorrectDocumentDependencies) {
  const now = deps.now ?? (() => new Date());

  return async function correctDocument(input: CorrectDocumentInput): Promise<CorrectionResult> {
    const hash = requestHash({ documentId: input.documentId, payload: input.payload });
    try {
      return await correctOnce(input, hash);
    } catch (error) {
      if (!(error instanceof IdempotencyKeyCollisionError)) throw error;
      return correctOnce(input, hash);
    }
  };

  async function correctOnce(input: CorrectDocumentInput, hash: string): Promise<CorrectionResult> {
    const at = now();
    const plan = await deps.unitOfWork.run(input.tenantId, (unit) =>
      planCorrection(unit, input, hash, at),
    );
    if (plan.kind === 'done') return plan.result;
    return reissue(input, hash, plan.document, plan.replacement);
  }

  /** Phase 1, one transaction: replay, validate and either rewrite the row or decide to reissue. */
  async function planCorrection(
    unit: CorrectionUnit,
    input: CorrectDocumentInput,
    hash: string,
    at: Date,
  ): Promise<Plan> {
    const replay = async (stored: StoredCorrection | null): Promise<Plan | null> => {
      if (!stored) return null;
      if (stored.requestHash !== hash) throw new IdempotencyKeyReusedError();
      if (!stored.replacement) {
        return { kind: 'done', result: { documentId: stored.documentId, cdc: stored.cdc } };
      }
      const document = await unit.lockDocument(stored.documentId);
      if (!document) throw new DocumentNotFoundError();
      return { kind: 'reissue', document, replacement: stored.replacement };
    };
    const early = await replay(await unit.findCorrectionByKey(input.idempotencyKey));
    if (early) return early;

    const document = await unit.lockDocument(input.documentId);
    // A concurrent retry with the same key may have committed while this one waited for the lock.
    const late = await replay(await unit.findCorrectionByKey(input.idempotencyKey));
    if (late) return late;
    if (!document) throw new DocumentNotFoundError();
    if (document.status !== 'rejected') throw new DocumentNotCorrectableError(document.status);
    if (await unit.findReissue(document.id)) throw new DocumentNotCorrectableError('reissued');

    const impact = classifyCorrection(document, {
      documentType: DOCUMENT_TYPE[input.correction.type],
      establishmentCode: input.establishmentCode,
      expeditionPointCode: input.expeditionPointCode,
      associatedCdc:
        'associatedCdc' in input.correction.draft ? input.correction.draft.associatedCdc : null,
    });
    if (impact.kind === 'type_changed') throw new CorrectionTypeChangedError();
    // The same CDC keeps the original issue date; past its 72 h window it cannot be resent (ADR-0008, ADR-0021).
    if (impact.kind === 'same_cdc' && at > transmissionDeadline(document.issuedAt)) {
      return { kind: 'reissue', document, replacement: null };
    }
    if (impact.kind === 'reissue') return { kind: 'reissue', document, replacement: null };

    const issuer = await unit.resolveIssuer({
      establishmentCode: input.establishmentCode,
      expeditionPointCode: input.expeditionPointCode,
      issueDate: paraguayDate(at),
    });
    if (!issuer) throw new IssuerNotConfiguredError();
    assertCertificateUsable(issuer, at, deps.certificateBlockDays);

    const { errors, receiverRuc } = await validateCorrection(
      unit,
      input,
      document.cdc,
      issuer.environment,
      deps.validation ?? {},
    );
    if (errors.length > 0) throw new InvoiceValidationError(errors);

    await unit.rewriteDocument({
      document,
      payload: input.payload,
      receiverRuc:
        input.correction.type === 'AFE' ? `${issuer.rucBase}-${String(issuer.rucDv)}` : receiverRuc,
      totalAmount: invoiceTotals(input.correction.draft).net.toString(),
      idempotencyKey: input.idempotencyKey,
      requestHash: hash,
    });
    await unit.recordAudit({
      actor: input.actor,
      action: 'document.corrected',
      entity: { type: 'document', id: document.id },
      before: { status: 'rejected' },
      after: { cdc: document.cdc, status: 'accepted', correction: 'same_cdc' },
    });
    return { kind: 'done', result: { documentId: document.id, cdc: document.cdc } };
  }

  /**
   * The replacement is a normal acceptance whose key derives from the rejected document, not from the correction's
   * key: concurrent corrections with other keys resolve to the same single replacement. The link is then recorded
   * under the document lock, still `rejected` and without a reissue, and the unique "one reissue per document"
   * makes the loser fail with a 409; the old number is voided last. Each step is idempotent, so a retry resumes
   * where it stopped, and a refused voiding is reported with the replacement instead of failing.
   */
  async function reissue(
    input: CorrectDocumentInput,
    hash: string,
    document: CorrectableDocument,
    stored: AcceptedInvoice | null,
  ): Promise<CorrectionResult> {
    const derived = requestHash({ reissueOf: document.id });
    const replacement = stored ?? (await issueAndLink(input, hash, document, derived));
    try {
      await deps.voidNumbers({
        tenantId: input.tenantId,
        actor: input.actor,
        body: {
          timbrado: document.timbradoNumber,
          establishment: document.establishmentCode,
          expeditionPoint: document.expeditionPointCode,
          type: document.documentType,
          ...(document.series === '' ? {} : { series: document.series }),
          from: document.number,
          to: document.number,
          reason: 'Reemision por correccion del documento rechazado',
        },
        idempotencyKey: `${derived}:void`,
      });
    } catch (error) {
      // The replacement exists and is linked: the refusal is reported with it, and a retry reports it again.
      if (error instanceof VoidRefusedError) return { ...replacement, voidRefused: error.errors };
      throw error;
    }
    return replacement;
  }

  async function issueAndLink(
    input: CorrectDocumentInput,
    hash: string,
    document: CorrectableDocument,
    derived: string,
  ): Promise<AcceptedInvoice> {
    const replacement = await acceptReplacement(input, `${derived}:reissue`);
    const link = () =>
      deps.unitOfWork.run(input.tenantId, async (unit) => {
        const current = await unit.lockDocument(document.id);
        if (!current) throw new DocumentNotFoundError();
        // A concurrent retry with the same key may have linked this replacement while this one waited.
        const done = await unit.findCorrectionByKey(input.idempotencyKey);
        if (done) {
          if (done.requestHash !== hash) throw new IdempotencyKeyReusedError();
          return;
        }
        if (current.status !== 'rejected') throw new DocumentNotCorrectableError(current.status);
        if (await unit.findReissue(current.id)) throw new DocumentNotCorrectableError('reissued');
        await unit.recordReissue({
          document: current,
          replacementDocumentId: replacement.documentId,
          idempotencyKey: input.idempotencyKey,
          requestHash: hash,
        });
        await unit.recordAudit({
          actor: input.actor,
          action: 'document.corrected',
          entity: { type: 'document', id: current.id },
          before: { status: 'rejected', cdc: current.cdc },
          after: { correction: 'reissue', replacementDocumentId: replacement.documentId },
        });
      });
    try {
      await link();
    } catch (error) {
      if (!(error instanceof IdempotencyKeyCollisionError)) throw error;
      await link();
    }
    return replacement;
  }

  function acceptReplacement(input: CorrectDocumentInput, idempotencyKey: string) {
    const base = {
      tenantId: input.tenantId,
      actor: input.actor,
      payload: input.payload,
      idempotencyKey,
      establishmentCode: input.establishmentCode,
      expeditionPointCode: input.expeditionPointCode,
    };
    const { correction } = input;
    switch (correction.type) {
      case 'FE':
        return deps.accept.FE({
          ...base,
          receiverRuc: correction.receiverRuc,
          draft: correction.draft,
        });
      case 'AFE':
        return deps.accept.AFE({ ...base, draft: correction.draft });
      default:
        return deps.accept[correction.type]({ ...base, draft: correction.draft });
    }
  }
}

type Plan =
  | { kind: 'done'; result: CorrectionResult }
  | { kind: 'reissue'; document: CorrectableDocument; replacement: AcceptedInvoice | null };
