import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database, DatabaseHandle } from '../src/client.js';
import { tenants } from '../src/schema.js';
import type { TenantTx } from '../src/tenant-transaction.js';
import { TenantAwareProcessor } from '../src/tenant-aware-processor.js';
import { createTestDatabase } from './support/harness.js';

interface ProbeJob {
  tenantId: string;
}

class ProbeProcessor extends TenantAwareProcessor<ProbeJob, number> {
  readonly handleSpy = vi.fn(async (_data: ProbeJob, tx: TenantTx) => {
    const rows = await tx.select().from(tenants);
    return rows.length;
  });

  constructor(db: Database) {
    super(db);
  }

  protected override handle(data: ProbeJob, tx: TenantTx): Promise<number> {
    return this.handleSpy(data, tx);
  }
}

describe('TenantAwareProcessor', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('runs the job body inside withTenantTransaction for the job tenant id', async () => {
    handle = await createTestDatabase();
    const [tenant] = await handle.db.insert(tenants).values({ name: 'Acme SA' }).returning();
    const processor = new ProbeProcessor(handle.db);

    const result = await processor.process({ data: { tenantId: tenant!.id } });

    expect(result).toBe(1);
    expect(processor.handleSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects a job missing a valid tenant id before running the body', async () => {
    handle = await createTestDatabase();
    const processor = new ProbeProcessor(handle.db);

    await expect(processor.process({ data: { tenantId: 'not-a-uuid' } })).rejects.toThrow(
      /Invalid tenant id/,
    );
    expect(processor.handleSpy).not.toHaveBeenCalled();
  });
});
