import { CdcReferenceError, createCdcReference } from '../domain/cdc-reference.js';
import type { CdcReferenceErrorCode } from '../domain/cdc-reference.js';
import type { ReceivedDocument } from '../domain/received-document.js';
import type { SolveSlot } from './ekuatia-solve-quota.js';
import type { EkuatiaLookupQueue } from './ports/ekuatia-lookup-queue.port.js';
import type { ReceivedDocumentRepository } from './ports/received-document-repository.port.js';

export interface IngestFromCdcDeps {
  /**
   * Kill switch AND configuration in one flag (`RECEPTION_EKUATIA_ENABLED` with a solver key).
   * False answers `disabled` before anything else is touched.
   */
  readonly enabled: boolean;
  readonly repository: Pick<ReceivedDocumentRepository, 'findByCdc'>;
  readonly quota: { reserve(tenantId: string): Promise<SolveSlot> };
  readonly queue: EkuatiaLookupQueue;
}

export interface IngestFromCdcInput {
  readonly tenantId: string;
  /** A bare 44-digit CDC or the QR URL of a KuDE (`...?Id=<cdc>`). */
  readonly reference: string;
}

export type IngestFromCdcResult =
  /** Kill switch off or solver not configured (HTTP 503 `ekuatia_unavailable`). */
  | { readonly kind: 'disabled' }
  /** No CDC in the input, or it failed validation. Rejected before any solve (HTTP 422). */
  | { readonly kind: 'invalid_reference'; readonly code: CdcReferenceErrorCode }
  /** A document with that CDC already exists for the tenant: nothing is solved (HTTP 200). */
  | { readonly kind: 'exists'; readonly document: ReceivedDocument }
  /** The daily solve cap of the tenant or of the platform is used up (HTTP 429). */
  | {
      readonly kind: 'quota_exceeded';
      readonly scope: 'tenant' | 'global';
      readonly cap: number;
      readonly retryAfterSeconds: number;
    }
  /** The queue refused the job; the solve slot was given back (HTTP 503). */
  | { readonly kind: 'queue_unavailable' }
  /** The lookup is queued (HTTP 202). `alreadyQueued` when an identical lookup was pending. */
  | { readonly kind: 'accepted'; readonly cdc: string; readonly alreadyQueued: boolean };

/** A QR URL is a few hundred characters; anything past this is not a CDC reference. */
const MAX_REFERENCE_LENGTH = 2048;

/**
 * Entry point of the lookup by CDC (reception R6.3, ADR-0027). It does the cheap, synchronous part:
 * validates the reference, dedupes against the tenant's documents and reserves a paid-solve slot,
 * then hands the lookup to the worker. Order matters: a bad reference and an already-known CDC
 * cost nothing. Logging is the caller's job and must carry ids only (never the CDC).
 */
export class IngestFromCdc {
  constructor(private readonly deps: IngestFromCdcDeps) {}

  async execute(input: IngestFromCdcInput): Promise<IngestFromCdcResult> {
    if (!this.deps.enabled) return { kind: 'disabled' };
    const { tenantId } = input;

    let cdc: string;
    try {
      if (input.reference.length > MAX_REFERENCE_LENGTH) {
        throw new CdcReferenceError('not-found', 'reference too long');
      }
      cdc = createCdcReference(input.reference).value;
    } catch (error) {
      if (error instanceof CdcReferenceError)
        return { kind: 'invalid_reference', code: error.code };
      throw error;
    }

    const existing = await this.deps.repository.findByCdc(tenantId, cdc);
    if (existing !== null) return { kind: 'exists', document: existing };

    const slot = await this.deps.quota.reserve(tenantId);
    if (!slot.ok) {
      return {
        kind: 'quota_exceeded',
        scope: slot.scope,
        cap: slot.cap,
        retryAfterSeconds: slot.retryAfterSeconds,
      };
    }
    try {
      const { enqueued } = await this.deps.queue.enqueueLookup({
        tenantId,
        cdc,
        usageDate: slot.usageDate,
      });
      // A lookup already pending owns its own slot: this request costs nothing.
      if (!enqueued) await slot.release();
      return { kind: 'accepted', cdc, alreadyQueued: !enqueued };
    } catch {
      await slot.release();
      return { kind: 'queue_unavailable' };
    }
  }
}
