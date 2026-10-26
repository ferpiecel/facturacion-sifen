import type { AuditEntry } from '../../../audit/application/ports/record-audit.port.js';
import type { VoidRange } from '../../domain/void-rules.js';
import type { Environment, StoredEvent } from './cancellation-unit-of-work.port.js';

/** Where a range lives: the tenant's own configuration, resolved from the codes the integrator sent. */
export type RangeScope =
  | {
      found: true;
      environment: Environment;
      timbradoId: string;
      establishmentId: string;
      expeditionPointId: string;
    }
  | { found: false; unknown: 'timbrado' | 'establishment' | 'expedition-point' };

export interface NewVoiding {
  environment: Environment;
  range: VoidRange;
  reason: string;
  idempotencyKey: string;
  requestHash: string;
}

/** Operations that must share one tenant transaction. */
export interface VoidingUnit {
  findByIdempotencyKey(key: string): Promise<StoredEvent | null>;
  resolveScope(range: VoidRange): Promise<RangeScope>;
  /**
   * Locks the numbering row of the range's point, type and series (it serializes concurrent voidings and
   * the issuing of numbers) and returns its last number, or null when no number was ever taken there.
   */
  lockLastNumber(
    scope: Extract<RangeScope, { found: true }>,
    range: VoidRange,
  ): Promise<number | null>;
  /**
   * Numbers inside the range that have a document SIFEN may hold or that is on its way there: every
   * status except `rejected` and `number_voided`. Ascending, at most `limit`.
   */
  listDocumentNumbersInRange(
    scope: Extract<RangeScope, { found: true }>,
    range: VoidRange,
    limit: number,
  ): Promise<number[]>;
  /** Voidings of the same timbrado, establishment, point, type and series that SIFEN did not refuse. */
  listOpenVoidRanges(range: VoidRange): Promise<VoidRange[]>;
  /** @throws EventKeyCollisionError when the key was taken by a concurrent commit. */
  insertVoiding(event: NewVoiding): Promise<{ id: string }>;
  recordAudit(entry: AuditEntry): Promise<void>;
}

export interface VoidingUnitOfWork {
  run<T>(tenantId: string, work: (unit: VoidingUnit) => Promise<T>): Promise<T>;
}
