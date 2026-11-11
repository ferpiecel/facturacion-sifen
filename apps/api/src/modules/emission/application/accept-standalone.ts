import { buildCdc } from '../domain/cdc.js';
import type { ValidationConfig, ValidationError } from '../domain/invoice-draft.js';
import { invoiceTotals } from '../domain/invoice-totals.js';
import { requestHash } from '../domain/request-hash.js';
import { generateSecurityCode, type RandomBytes } from '../domain/security-code.js';
import { validateRemissionDraft, type RemissionDraft } from '../domain/remission-draft.js';
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
import {
  IdempotencyKeyCollisionError,
  type AcceptanceUnitOfWork,
  type IssuerContext,
} from './ports/acceptance-unit-of-work.port.js';

const NORMAL_EMISSION = 1; // iTipEmi

/** What differs between the documents that stand alone (no associated FE): the AFE and the NRE. */
export interface StandaloneKind<Draft> {
  /** iTiDE (4 AFE, 7 NRE). */
  documentType: number;
  validate(draft: Draft, config: ValidationConfig): ValidationError[];
  total(draft: Draft): string;
  receiverRuc(draft: Draft, issuer: IssuerContext): string | null;
  /** Rules that need the issuer (known only inside the transaction); checked before numbering. */
  validateWithIssuer?(
    draft: Draft,
    issuer: IssuerContext,
    config: ValidationConfig,
  ): ValidationError[];
}

export interface AcceptStandaloneInput<Draft> {
  tenantId: string;
  actor: AuditEntry['actor'];
  establishmentCode: string;
  expeditionPointCode: string;
  draft: Draft;
  payload: unknown;
  idempotencyKey: string;
}

export interface AcceptStandaloneDependencies {
  unitOfWork: AcceptanceUnitOfWork;
  now?: () => Date;
  randomBytes?: RandomBytes;
  validation?: ValidationConfig;
  certificateBlockDays?: number;
}

/**
 * Accepts a document with no associated FE (HU-E7-03, HU-E7-04): validates before the transaction
 * (a refusal burns no number), then numbers and stores it as `accepted`. Idempotent like `acceptInvoice`.
 *
 * @throws InvoiceValidationError, IssuerNotConfiguredError, IdempotencyKeyReusedError
 */
export function createAcceptStandalone<Draft>(
  deps: AcceptStandaloneDependencies,
  kind: StandaloneKind<Draft>,
) {
  const now = deps.now ?? (() => new Date());

  return async function accept(input: AcceptStandaloneInput<Draft>): Promise<AcceptedInvoice> {
    const errors = kind.validate(input.draft, deps.validation ?? {});
    if (errors.length > 0) throw new InvoiceValidationError(errors);

    const hash = requestHash(input.payload);
    try {
      return await acceptOnce(input, hash);
    } catch (error) {
      if (!(error instanceof IdempotencyKeyCollisionError)) throw error;
      return acceptOnce(input, hash);
    }
  };

  async function acceptOnce(
    input: AcceptStandaloneInput<Draft>,
    hash: string,
  ): Promise<AcceptedInvoice> {
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
      const issuerErrors = kind.validateWithIssuer?.(input.draft, issuer, deps.validation ?? {});
      if (issuerErrors && issuerErrors.length > 0) throw new InvoiceValidationError(issuerErrors);

      const { series, number } = await unit.nextNumber(issuer, kind.documentType);
      const securityCode = generateSecurityCode(number, deps.randomBytes);
      const cdc = buildCdc({
        documentType: String(kind.documentType).padStart(2, '0'),
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
        documentType: kind.documentType,
        timbradoId: issuer.timbradoId,
        establishmentId: issuer.establishmentId,
        expeditionPointId: issuer.expeditionPointId,
        series: series ?? '',
        number,
        securityCode,
        receiverRuc: kind.receiverRuc(input.draft, issuer),
        issuedAt,
        totalAmount: kind.total(input.draft),
        currency: 'PYG',
        payload: input.payload,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
      });
      await unit.recordAudit({
        actor: input.actor,
        action: 'document.accepted',
        entity: { type: 'document', id },
        before: null,
        after: { cdc, status: 'accepted' },
      });
      return { documentId: id, cdc };
    });
  }
}

export type AcceptSelfInvoiceInput = AcceptStandaloneInput<SelfInvoiceDraft>;

/** Accepts an AFE (iTiDE 4): the receiver is the issuer, so its RUC is the issuer's (1317). */
export function createAcceptSelfInvoice(deps: AcceptStandaloneDependencies) {
  return createAcceptStandalone<SelfInvoiceDraft>(deps, {
    documentType: 4,
    validate: validateSelfInvoiceDraft,
    total: (draft) => invoiceTotals(draft).net.toString(),
    receiverRuc: (_draft, issuer) => `${issuer.rucBase}-${String(issuer.rucDv)}`,
  });
}

export type AcceptRemissionInput = AcceptStandaloneInput<RemissionDraft>;

/** Accepts an NRE (iTiDE 7): no money (total 0) and the receiver RUC of the draft (D206). */
export function createAcceptRemission(deps: AcceptStandaloneDependencies) {
  return createAcceptStandalone<RemissionDraft>(deps, {
    documentType: 7,
    validate: (draft, config) => validateRemissionDraft(draft, config),
    // Only the rules that need the issuer are new here: the others already ran.
    validateWithIssuer: (draft, issuer, config) =>
      validateRemissionDraft(draft, config, `${issuer.rucBase}-${String(issuer.rucDv)}`).filter(
        (error) => error.rule === 'remission-motive-7-receiver',
      ),
    total: () => '0',
    receiverRuc: (draft) => draft.receiver.ruc ?? null,
  });
}
