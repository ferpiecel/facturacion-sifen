import type { ExtractionUsageStore } from './ports/extraction-usage-store.port.js';

export interface ExtractionQuotaDeps {
  readonly store: ExtractionUsageStore;
  /** Extractions a tenant may queue per UTC day (`RECEPTION_EXTRACTION_DAILY_CAP`). */
  readonly dailyCap: number;
  readonly now: () => Date;
  /** Receives ids and counts only; never document content, URLs or keys. */
  readonly log: (message: string, fields: Readonly<Record<string, number | string>>) => void;
}

export type ExtractionReservation =
  | {
      readonly ok: true;
      readonly used: number;
      readonly cap: number;
      /** Gives the slot back when the extraction was not queued after all. Best effort, once. */
      release(): Promise<void>;
    }
  | { readonly ok: false; readonly cap: number; readonly retryAfterSeconds: number };

/** The tenant reached its daily extraction cap (HTTP 429 `extraction_quota_exceeded`). */
export class ExtractionQuotaExceededError extends Error {
  constructor(
    readonly cap: number,
    readonly retryAfterSeconds: number,
  ) {
    super('the daily extraction quota of the tenant is exhausted');
    this.name = 'ExtractionQuotaExceededError';
  }
}

/** UTC calendar day as `YYYY-MM-DD`: the unit the quota is counted in. */
export function usageDateOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

const DAY_MS = 86_400_000;

/**
 * Per-tenant daily cap on LLM extractions (reception R5.9, ADR-0026 point 6). Every extraction
 * that is queued (PDF or photo upload, or a reprocess) first reserves a slot; the store takes it
 * atomically, so concurrent requests cannot overshoot the cap.
 */
export class ExtractionQuota {
  constructor(private readonly deps: ExtractionQuotaDeps) {}

  async reserve(tenantId: string): Promise<ExtractionReservation> {
    const { store, dailyCap: cap, log } = this.deps;
    const at = this.deps.now();
    const usageDate = usageDateOf(at);
    const used = await store.tryConsume(tenantId, usageDate, cap);
    if (used === null) {
      log('reception extraction quota exceeded', { tenantId, cap });
      const nextDay = Date.parse(`${usageDate}T00:00:00.000Z`) + DAY_MS;
      const retryAfterSeconds = Math.max(1, Math.ceil((nextDay - at.getTime()) / 1000));
      return { ok: false, cap, retryAfterSeconds };
    }
    log('reception extraction usage', { tenantId, used, cap });
    let released = false;
    return {
      ok: true,
      used,
      cap,
      release: async () => {
        if (released) return;
        released = true;
        // The slot belongs to the day it was taken, even if the clock rolled over meanwhile.
        await store.release(tenantId, usageDate).catch(() => undefined);
      },
    };
  }
}
