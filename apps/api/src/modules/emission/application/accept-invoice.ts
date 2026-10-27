import { buildCdc } from '../domain/cdc.js';
import {
  validateInvoiceDraft,
  type InvoiceDraft,
  type ValidationConfig,
  type ValidationError,
} from '../domain/invoice-draft.js';
import { invoiceTotals } from '../domain/invoice-totals.js';
import { requestHash } from '../domain/request-hash.js';
import { generateSecurityCode, type RandomBytes } from '../domain/security-code.js';
import type { AuditEntry } from '../../audit/application/ports/record-audit.port.js';
import {
  DEFAULT_EMISSION_BLOCK_DAYS,
  isEmissionBlocked,
} from '../../certificates/domain/certificate-expiry.js';
import {
  IdempotencyKeyCollisionError,
  type AcceptanceUnitOfWork,
  type IssuerContext,
} from './ports/acceptance-unit-of-work.port.js';

/** iTiDE of an electronic invoice (FE). */
const INVOICE_DOCUMENT_TYPE = 1;
/** iTipEmi: normal emission. */
const NORMAL_EMISSION = 1;
const PARAGUAY_TIME_ZONE = 'America/Asuncion';

export class InvoiceValidationError extends Error {
  constructor(readonly errors: ValidationError[]) {
    super(`Invoice draft has ${String(errors.length)} validation error(s)`);
    this.name = 'InvoiceValidationError';
  }
}

/** The establishment, expedition point or an active timbrado is not configured for the tenant. */
export class IssuerNotConfiguredError extends Error {
  constructor() {
    super('Establishment, expedition point or active timbrado not configured for this tenant');
    this.name = 'IssuerNotConfiguredError';
  }
}

/** HU-E3-03: the active certificate expires within the preventive window (or already did). */
export class CertificateExpiringError extends Error {
  constructor(readonly notAfter: Date) {
    super(
      `The signing certificate expires on ${notAfter.toISOString()}; upload a renewed certificate before issuing documents`,
    );
    this.name = 'CertificateExpiringError';
  }
}

/** Refuses emission from `blockDays` before the active certificate's expiry; no certificate is not a block here. */
export function assertCertificateUsable(
  issuer: IssuerContext,
  now: Date,
  blockDays = DEFAULT_EMISSION_BLOCK_DAYS,
): void {
  const { certificateNotAfter } = issuer;
  if (certificateNotAfter && isEmissionBlocked(certificateNotAfter, now, blockDays)) {
    throw new CertificateExpiringError(certificateNotAfter);
  }
}

/** The `Idempotency-Key` was already used with a different request body. */
export class IdempotencyKeyReusedError extends Error {
  constructor() {
    super('Idempotency-Key was already used with a different request payload');
    this.name = 'IdempotencyKeyReusedError';
  }
}

export interface AcceptInvoiceInput {
  tenantId: string;
  actor: AuditEntry['actor'];
  /** dEst and dPunExp. The timbrado and the emitter RUC are resolved server-side. */
  establishmentCode: string;
  expeditionPointCode: string;
  draft: InvoiceDraft;
  receiverRuc: string | null;
  /** The request body as received. */
  payload: unknown;
  /** `Idempotency-Key` header, unique per tenant. */
  idempotencyKey: string;
}

export interface AcceptInvoiceDependencies {
  unitOfWork: AcceptanceUnitOfWork;
  now?: () => Date;
  randomBytes?: RandomBytes;
  validation?: ValidationConfig;
  /** Days before the certificate's expiry from which emission is refused (HU-E3-03). */
  certificateBlockDays?: number;
}

export interface AcceptedInvoice {
  documentId: string;
  cdc: string;
}

/** Calendar date in Paraguay (`YYYY-MM-DD`), used for the CDC and the timbrado validity. */
export function paraguayDate(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: PARAGUAY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/**
 * Accepts an FE (HU-E5-01): validates it, assigns its number and a random
 * dCodSeg, computes the CDC and persists the document as `accepted` with its
 * audit row. Validation runs before any transaction so a bad draft never burns
 * a number; everything else shares one tenant transaction. Signing and
 * transmission happen later.
 *
 * Idempotent (HU-E5-02): the same `idempotencyKey` and body replays the first
 * result without creating anything. The key is checked inside the transaction
 * and enforced by a unique constraint; a concurrent loser rolls back and
 * re-reads once.
 *
 * @throws InvoiceValidationError, IssuerNotConfiguredError, IdempotencyKeyReusedError
 */
export function createAcceptInvoice(deps: AcceptInvoiceDependencies) {
  const now = deps.now ?? (() => new Date());

  return async function acceptInvoice(input: AcceptInvoiceInput): Promise<AcceptedInvoice> {
    const errors = validateInvoiceDraft(input.draft, deps.validation ?? {});
    if (errors.length > 0) throw new InvoiceValidationError(errors);

    const hash = requestHash(input.payload);
    try {
      return await acceptOnce(input, hash);
    } catch (error) {
      if (!(error instanceof IdempotencyKeyCollisionError)) throw error;
      // A concurrent request committed the key first; it is visible now.
      return acceptOnce(input, hash);
    }
  };

  async function acceptOnce(input: AcceptInvoiceInput, hash: string): Promise<AcceptedInvoice> {
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

      const { series, number } = await unit.nextNumber(issuer, INVOICE_DOCUMENT_TYPE);
      const securityCode = generateSecurityCode(number, deps.randomBytes);
      const cdc = buildCdc({
        documentType: String(INVOICE_DOCUMENT_TYPE).padStart(2, '0'),
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
        documentType: INVOICE_DOCUMENT_TYPE,
        timbradoId: issuer.timbradoId,
        establishmentId: issuer.establishmentId,
        expeditionPointId: issuer.expeditionPointId,
        series: series ?? '',
        number,
        securityCode,
        receiverRuc: input.receiverRuc,
        issuedAt,
        totalAmount: invoiceTotals(input.draft).net.toString(),
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
