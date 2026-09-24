import type { Database } from './client.js';
import { withTenantTransaction, type TenantTx } from './tenant-transaction.js';

/** Structural job shape: never depends on `bullmq`, so this package stays framework-free. */
export interface TenantJob<P> {
  data: P;
}

/**
 * Base class for worker processors that must run every job inside a
 * tenant-scoped transaction. `process()` resolves `job.data.tenantId` and
 * runs `handle()` through {@link withTenantTransaction}, which validates
 * the tenant id as a UUID *before* the transaction opens — so a job
 * missing a valid tenant id is rejected before `handle()` ever runs
 * (spec: db-access, worker processor runs jobs in tenant transaction).
 */
export abstract class TenantAwareProcessor<P extends { tenantId: string }, R> {
  private readonly db: Database;

  protected constructor(db: Database) {
    this.db = db;
  }

  async process(job: TenantJob<P>): Promise<R> {
    return withTenantTransaction(this.db, job.data.tenantId, (tx) => this.handle(job.data, tx));
  }

  protected abstract handle(data: P, tx: TenantTx): Promise<R>;
}
