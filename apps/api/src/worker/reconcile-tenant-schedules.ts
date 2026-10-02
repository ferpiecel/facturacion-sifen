import type { TenantScheduleStore } from './queue.js';
import type { TenantDirectory } from './tenant-directory.js';

export interface ReconcileTenantSchedulesOptions {
  readonly directory: TenantDirectory;
  readonly schedules: TenantScheduleStore;
  readonly everyMs: number;
  /** Re-upsert every tenant so a changed cadence takes effect (done once at startup). */
  readonly refresh?: boolean;
}

/** Brings the repeatable jobs in step with the tenants: one per tenant, none for removed ones. */
export async function reconcileTenantSchedules({
  directory,
  schedules,
  everyMs,
  refresh = false,
}: ReconcileTenantSchedulesOptions): Promise<{ added: string[]; removed: string[] }> {
  const tenantIds = await directory.tenantIds();
  const scheduled = new Set(await schedules.list());
  const wanted = new Set(tenantIds);

  const added = tenantIds.filter((id) => !scheduled.has(id));
  const removed = [...scheduled].filter((id) => !wanted.has(id));
  for (const id of refresh ? tenantIds : added) await schedules.upsert(id, everyMs);
  for (const id of removed) await schedules.remove(id);
  return { added, removed };
}
