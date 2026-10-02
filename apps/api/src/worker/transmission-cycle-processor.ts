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
  readonly createCycle: (tenantId: string) => { run(): Promise<CycleReport> };
  readonly logger: WorkerLogger;
}

export type CycleJobResult = { readonly status: 'done' | 'skipped' };

/**
 * Handles one `lote-build` job: validates the tenant id (ADR-0006: nothing runs for an invalid
 * tenant), takes the tenant's run lock so two workers never run the same tenant at once, runs the
 * cycle and logs its report. Logs carry counts, ids and error classes only, never payloads or secrets.
 */
export class TransmissionCycleProcessor {
  constructor(private readonly deps: TransmissionCycleProcessorDeps) {}

  async process(data: unknown): Promise<CycleJobResult> {
    const tenantId = (data as { tenantId?: unknown } | null)?.tenantId;
    if (!isValidTenantId(tenantId)) throw new Error('invalid tenant id in job data');

    const release = await this.deps.lock.acquire(tenantId);
    if (!release) {
      this.deps.logger.info(`transmission cycle skipped, tenant ${tenantId} already running`);
      return { status: 'skipped' };
    }
    try {
      this.log(tenantId, await this.deps.createCycle(tenantId).run());
      return { status: 'done' };
    } catch (error) {
      const kind = error instanceof Error ? error.name : 'unknown error';
      this.deps.logger.error(`transmission cycle failed for tenant ${tenantId}: ${kind}`);
      throw error;
    } finally {
      await release();
    }
  }

  private log(tenantId: string, report: CycleReport): void {
    const { logger } = this.deps;
    logger.info(
      `transmission cycle tenant=${tenantId} signed=${String(report.signed)} ` +
        `skipped=${String(report.signSkipped)} assembled=${String(report.assembled)} ` +
        `sent=${String(report.sent.length)} polled=${String(report.polled.length)}`,
    );
    if (report.held.length > 0) {
      const held = report.held.map((h) => `${h.documentId} ${h.reason}`).join(', ');
      logger.warn(
        `tenant ${tenantId} held=${String(report.held.length)} needs an operator: ${held}`,
      );
    }
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
}
