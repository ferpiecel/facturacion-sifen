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
import type { AuditEntry } from '../../audit/application/ports/record-audit.port.js';
import {
  IdempotencyKeyReusedError,
  InvoiceValidationError,
  IssuerNotConfiguredError,
  assertCertificateUsable,
  paraguayDate,
  type AcceptedInvoice,
} from './accept-invoice.js';
import { IdempotencyKeyCollisionError } from './ports/acceptance-unit-of-work.port.js';
import type {
  CorrectionUnit,
  CorrectionUnitOfWork,
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

/** The correction changes a CDC component; the reissue path is not available yet. */
export class CorrectionRequiresReissueError extends Error {
  constructor(readonly reasons: string[]) {
    super(`The correction changes the document number (${reasons.join(', ')})`);
    this.name = 'CorrectionRequiresReissueError';
  }
}

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

export interface CorrectDocumentDependencies {
  unitOfWork: CorrectionUnitOfWork;
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
 * Corrects a `rejected` document (HU-E8-01, ADR-0021) when the correction keeps every CDC component:
 * the same row is rewritten and queued again with the same CDC, its previous body kept in the history.
 * Idempotent through the correction's own `Idempotency-Key`.
 *
 * @throws DocumentNotFoundError, DocumentNotCorrectableError, CorrectionTypeChangedError,
 *   CorrectionRequiresReissueError, InvoiceValidationError, IssuerNotConfiguredError,
 *   IdempotencyKeyReusedError
 */
export function createCorrectDocument(deps: CorrectDocumentDependencies) {
  const now = deps.now ?? (() => new Date());

  return async function correctDocument(input: CorrectDocumentInput): Promise<AcceptedInvoice> {
    const hash = requestHash({ documentId: input.documentId, payload: input.payload });
    try {
      return await correctOnce(input, hash);
    } catch (error) {
      if (!(error instanceof IdempotencyKeyCollisionError)) throw error;
      return correctOnce(input, hash);
    }
  };

  async function correctOnce(input: CorrectDocumentInput, hash: string): Promise<AcceptedInvoice> {
    const at = now();
    return deps.unitOfWork.run(input.tenantId, async (unit) => {
      const replay = (stored: StoredCorrection | null): AcceptedInvoice | null => {
        if (!stored) return null;
        if (stored.requestHash !== hash) throw new IdempotencyKeyReusedError();
        return { documentId: stored.documentId, cdc: stored.cdc };
      };
      const early = replay(await unit.findCorrectionByKey(input.idempotencyKey));
      if (early) return early;

      const document = await unit.lockDocument(input.documentId);
      // A concurrent retry with the same key may have committed while this one waited for the lock.
      const late = replay(await unit.findCorrectionByKey(input.idempotencyKey));
      if (late) return late;
      if (!document) throw new DocumentNotFoundError();
      if (document.status !== 'rejected') throw new DocumentNotCorrectableError(document.status);

      const impact = classifyCorrection(document, {
        documentType: DOCUMENT_TYPE[input.correction.type],
        establishmentCode: input.establishmentCode,
        expeditionPointCode: input.expeditionPointCode,
        associatedCdc:
          'associatedCdc' in input.correction.draft ? input.correction.draft.associatedCdc : null,
      });
      if (impact.kind === 'type_changed') throw new CorrectionTypeChangedError();
      if (impact.kind === 'reissue') throw new CorrectionRequiresReissueError(impact.reasons);

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
          input.correction.type === 'AFE'
            ? `${issuer.rucBase}-${String(issuer.rucDv)}`
            : receiverRuc,
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
      return { documentId: document.id, cdc: document.cdc };
    });
  }
}
