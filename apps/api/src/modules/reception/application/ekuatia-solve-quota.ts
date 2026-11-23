import { usageDateOf } from './extraction-quota.js';
import type { SolveUsageStore } from './ports/solve-usage-store.port.js';

export interface EkuatiaSolveQuotaDeps {
  readonly store: SolveUsageStore;
  /** Lookups a tenant may queue per UTC day (`RECEPTION_EKUATIA_DAILY_SOLVE_CAP`). */
  readonly tenantCap: number;
  /** Lookups all tenants together may queue per UTC day (`RECEPTION_EKUATIA_GLOBAL_DAILY_SOLVE_CAP`). */
  readonly globalCap: number;
  readonly now: () => Date;
  /** Receives ids and counts only; never a CDC, URL or key. */
  readonly log: (message: string, fields: Readonly<Record<string, number | string>>) => void;
}

export type SolveSlot =
  | {
      readonly ok: true;
      /** UTC day the slot belongs to; the job carries it so the worker can give the slot back. */
      readonly usageDate: string;
      /** Gives the slot back when no solve will happen after all. Best effort, once. */
      release(): Promise<void>;
    }
  | {
      readonly ok: false;
      readonly scope: 'tenant' | 'global';
      readonly cap: number;
      readonly retryAfterSeconds: number;
    };

const DAY_MS = 86_400_000;

/**
 * Spend guard on paid captcha solves (reception R6.3, risk R-3): one slot per queued lookup, taken
 * from a per-tenant and a platform-wide daily counter at once. The defaults are conservative and
 * must be confirmed by the product owner.
 */
export class EkuatiaSolveQuota {
  constructor(private readonly deps: EkuatiaSolveQuotaDeps) {
    for (const [name, cap] of [
      ['tenantCap', deps.tenantCap],
      ['globalCap', deps.globalCap],
    ] as const) {
      if (!Number.isInteger(cap) || cap < 1)
        throw new RangeError(`${name} must be a positive integer`);
    }
  }

  async reserve(tenantId: string): Promise<SolveSlot> {
    const { store, tenantCap, globalCap, log } = this.deps;
    const at = this.deps.now();
    const usageDate = usageDateOf(at);
    const taken = await store.tryConsume(tenantId, usageDate, {
      tenant: tenantCap,
      global: globalCap,
    });
    if (!taken.ok) {
      const cap = taken.scope === 'tenant' ? tenantCap : globalCap;
      log('reception ekuatia solve quota exceeded', { tenantId, scope: taken.scope, cap });
      const nextDay = Date.parse(`${usageDate}T00:00:00.000Z`) + DAY_MS;
      const retryAfterSeconds = Math.max(1, Math.ceil((nextDay - at.getTime()) / 1000));
      return { ok: false, scope: taken.scope, cap, retryAfterSeconds };
    }
    log('reception ekuatia solve reserved', { tenantId, usageDate });
    let released = false;
    return {
      ok: true,
      usageDate,
      release: async () => {
        if (released) return;
        released = true;
        await this.releaseByDay(tenantId, usageDate);
      },
    };
  }

  /** The slot belongs to the day it was taken, even if the clock rolled over meanwhile. */
  async releaseByDay(tenantId: string, usageDate: string): Promise<void> {
    await this.deps.store.release(tenantId, usageDate).catch(() => undefined);
  }
}
