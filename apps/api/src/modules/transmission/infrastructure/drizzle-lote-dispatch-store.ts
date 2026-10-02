import { and, eq } from 'drizzle-orm';
import { lotes, withTenantTransaction, type Database } from '@sifen/db';
import type { LoteDispatchOutcome, LoteDispatchStore } from '../application/send-lote.js';

const FIRST_POLL_DELAY_MS = 10 * 60 * 1000;
/** Lote queries are valid for 48 h after sending (0364). */
const POLL_WINDOW_MS = 48 * 60 * 60 * 1000;

export interface DrizzleLoteDispatchStoreOptions {
  readonly db: Database;
  readonly tenantId: string;
  readonly now?: () => Date;
}

/** `LoteDispatchStore` over `lotes`; every call runs as app_user inside the tenant's transaction. */
export function createDrizzleLoteDispatchStore({
  db,
  tenantId,
  now = () => new Date(),
}: DrizzleLoteDispatchStoreOptions): LoteDispatchStore {
  return {
    async claim(loteId) {
      // One atomic conditional UPDATE: only the caller that flips pending -> sending wins.
      const claimed = await withTenantTransaction(db, tenantId, (tx) =>
        tx
          .update(lotes)
          .set({ status: 'sending', updatedAt: now() })
          .where(and(eq(lotes.id, loteId), eq(lotes.status, 'pending')))
          .returning({ id: lotes.id }),
      );
      return claimed.length === 1;
    },

    async record(loteId, outcome) {
      const updated = await withTenantTransaction(db, tenantId, (tx) =>
        tx
          .update(lotes)
          .set({ ...columnsFor(outcome, now()), updatedAt: now() })
          .where(and(eq(lotes.id, loteId), eq(lotes.status, 'sending')))
          .returning({ id: lotes.id }),
      );
      if (updated.length !== 1) throw new Error(`Lote ${loteId} is not in sending state`);
    },
  };
}

function columnsFor(outcome: LoteDispatchOutcome, at: Date): Partial<typeof lotes.$inferInsert> {
  switch (outcome.status) {
    case 'sent':
      return {
        status: 'sent',
        sifenProtocol: outcome.dProtConsLote,
        sentAt: at,
        nextPollAt: new Date(at.getTime() + FIRST_POLL_DELAY_MS),
        pollDeadlineAt: new Date(at.getTime() + POLL_WINDOW_MS),
      };
    case 'rejected':
      return { status: 'rejected', responseCode: outcome.code, responseMessage: outcome.reason };
    case 'unknown':
      return { status: 'unknown', responseMessage: outcome.reason };
  }
}
