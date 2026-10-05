import { isValidTenantId } from '@sifen/db';
import type { CycleReport } from '../modules/transmission/application/transmission-cycle.js';
import type { TenantRunLock } from './tenant-run-lock.js';

export interface WorkerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface TransmissionCycleProcessorDeps {
  readonly lock: TenantRunLock;
  /** Builds the tenant's cycle (every store runs inside the tenant's own transaction, ADR-0006). */
  readonly createCycle: (tenantId: string) => {
    run(options?: { signal?: AbortSignal }): Promise<CycleReport>;
  };
  readonly logger: WorkerLogger;
  readonly now?: () => Date;
  /** The held-document id list is logged at most this often per tenant (default 10 minutes). */
  readonly heldListEveryMs?: number;
}

export type CycleJobResult = { readonly status: 'done' | 'skipped' };

/**
 * Handles one `lote-build` job: validates the tenant id (ADR-0006: nothing runs for an invalid
 * tenant), takes the tenant's run lock so two workers never run the same tenant at once, runs the
 * cycle and logs its report. Logs carry counts, ids and error classes only, never payloads or secrets.
 */
export class TransmissionCycleProcessor {
  private readonly lastHeldList = new Map<string, number>();

  constructor(private readonly deps: TransmissionCycleProcessorDeps) {}

  async process(data: unknown): Promise<CycleJobResult> {
    const tenantId = (data as { tenantId?: unknown } | null)?.tenantId;
    if (!isValidTenantId(tenantId)) throw new Error('invalid tenant id in job data');

    const lease = await this.deps.lock.acquire(tenantId);
    if (!lease) {
      this.deps.logger.info(`transmission cycle skipped, tenant ${tenantId} already running`);
      return { status: 'skipped' };
    }
    try {
      this.log(tenantId, await this.deps.createCycle(tenantId).run({ signal: lease.signal }));
      return { status: 'done' };
    } catch (error) {
      const kind = error instanceof Error ? error.name : 'unknown error';
      this.deps.logger.error(`transmission cycle failed for tenant ${tenantId}: ${kind}`);
      throw error;
    } finally {
      await lease.release();
    }
  }

  private log(tenantId: string, report: CycleReport): void {
    const { logger } = this.deps;
    logger.info(
      `transmission cycle tenant=${tenantId} signed=${String(report.signed)} ` +
        `skipped=${String(report.signSkipped)} assembled=${String(report.assembled)} ` +
        `sent=${String(report.sent.length)} polled= ` +
        `recovered=`,
    );
    if (report.aborted) {
      logger.warn(
        `tenant ${tenantId} cycle lost the run lock and stopped early; the next run resumes`,
      );
    }
    if (report.held.length > 0) logger.warn(this.heldMessage(tenantId, report.held));
    if (report.stalePending > 0) {
      logger.warn(`tenant ${tenantId} stalePending=${String(report.stalePending)} lotes not sent`);
    }
    if (report.failures.length > 0) {
      const failures = report.failures
        .map((f) => [f.step, f.id, f.error].filter(Boolean).join(' '))
        .join(', ');
      logger.warn(`tenant ${tenantId} failures=${String(report.failures.length)}: ${failures}`);
    }
  }

  /** The count goes out every cycle; the ids (first 10) only once per `heldListEveryMs`, to keep the log quiet. */
  private heldMessage(tenantId: string, held: CycleReport['held']): string {
    const nowMs = (this.deps.now ?? (() => new Date()))().getTime();
    const last = this.lastHeldList.get(tenantId);
    const base = `tenant ${tenantId} held=${String(held.length)} needs an operator`;
    if (last !== undefined && nowMs - last < (this.deps.heldListEveryMs ?? 600_000)) return base;
    this.lastHeldList.set(tenantId, nowMs);
    const ids = held
      .slice(0, 10)
      .map((h) => `${h.documentId} ${h.reason}`)
      .join(', ');
    return `${base}: ${ids}${held.length > 10 ? ', ...' : ''}`;
  }
}
