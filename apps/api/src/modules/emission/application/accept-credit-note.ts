import { buildCdc } from '../domain/cdc.js';
import { validateCreditNoteDraft, type CreditNoteDraft } from '../domain/credit-note-draft.js';
import type { ValidationConfig } from '../domain/invoice-draft.js';
import { invoiceTotals } from '../domain/invoice-totals.js';
import { requestHash } from '../domain/request-hash.js';
import { generateSecurityCode, type RandomBytes } from '../domain/security-code.js';
import type { AuditEntry } from '../../audit/application/ports/record-audit.port.js';
import {
  IdempotencyKeyReusedError,
  InvoiceValidationError,
  IssuerNotConfiguredError,
  paraguayDate,
  type AcceptedInvoice,
} from './accept-invoice.js';
import {
  IdempotencyKeyCollisionError,
  type AcceptanceUnitOfWork,
} from './ports/acceptance-unit-of-work.port.js';

const CREDIT_NOTE_DOCUMENT_TYPE = 5; // iTiDE of an NCE
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

      const { associatedCdc } = input.draft;
      const invoice = await unit.findAssociatedInvoice(associatedCdc, issuer.environment);
      const creditedAmount = invoice
        ? await unit.sumCreditNotes(associatedCdc, issuer.environment)
        : '0';
      const errors = validateCreditNoteDraft(
        input.draft,
        invoice ? { ...invoice, creditedAmount } : undefined,
        deps.validation ?? {},
      );
      if (errors.length > 0) throw new InvoiceValidationError(errors);

      const { series, number } = await unit.nextNumber(issuer, CREDIT_NOTE_DOCUMENT_TYPE);
      const securityCode = generateSecurityCode(number, deps.randomBytes);
      const cdc = buildCdc({
        documentType: String(CREDIT_NOTE_DOCUMENT_TYPE).padStart(2, '0'),
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
        documentType: CREDIT_NOTE_DOCUMENT_TYPE,
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
