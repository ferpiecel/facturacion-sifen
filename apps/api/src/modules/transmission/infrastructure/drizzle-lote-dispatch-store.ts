import { and, eq, inArray } from 'drizzle-orm';
import { documents, loteDocuments, lotes, withTenantTransaction, type Database } from '@sifen/db';
import { recordAudit } from '../../audit/infrastructure/record-audit.js';
import { enqueueDocumentEvents } from '../../webhooks/infrastructure/enqueue-document-events.js';
import type { LoteDispatchOutcome, LoteDispatchStore } from '../application/send-lote.js';
import { RECOVERY_UNRESOLVED_HOLD } from './drizzle-lote-recovery-store.js';
import { TRANSMISSION_WORKER_ACTOR } from './transmission-audit-actor.js';

/** First wait after a 0301; it doubles on each refusal up to the cap. */
const BASE_BACKOFF_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_MAX_TRANSMISSION_ATTEMPTS = 5;
export const ATTEMPTS_EXHAUSTED_HOLD = 'transmission:attempts-exhausted';
const FIRST_POLL_DELAY_MS = 10 * 60 * 1000;
/** Lote queries are valid for 48 h after sending (0364). */
const POLL_WINDOW_MS = 48 * 60 * 60 * 1000;

type Tx = Parameters<Parameters<typeof withTenantTransaction>[2]>[0];

export interface DrizzleLoteDispatchStoreOptions {
  readonly db: Database;
  readonly tenantId: string;
  readonly now?: () => Date;
  /** 0301 refusals after which a document is held for an operator instead of re-queued. */
  readonly maxTransmissionAttempts?: number;
}

/** `LoteDispatchStore` over `lotes`; every call runs as app_user inside the tenant's transaction. */
export function createDrizzleLoteDispatchStore({
  db,
  tenantId,
  now = () => new Date(),
  maxTransmissionAttempts = DEFAULT_MAX_TRANSMISSION_ATTEMPTS,
}: DrizzleLoteDispatchStoreOptions): LoteDispatchStore {
  return {
    async claim(loteId) {
      // One atomic conditional UPDATE: only the caller that flips pending -> sending wins.
      const claimed = await withTenantTransaction(db, tenantId, (tx) =>
        tx
          .update(lotes)
          .set({ status: 'sending', sendAttemptedAt: now(), updatedAt: now() })
          .where(and(eq(lotes.id, loteId), eq(lotes.status, 'pending')))
          .returning({ id: lotes.id }),
      );
      return claimed.length === 1;
    },

    async record(loteId, outcome) {
      await withTenantTransaction(db, tenantId, async (tx) => {
        const updated = await tx
          .update(lotes)
          .set({ ...columnsFor(outcome, now()), updatedAt: now() })
          .where(
            and(
              eq(lotes.id, loteId),
              // `unknown`: the sweep gave up on a slow send that has now finished; its protocol must not be lost.
              inArray(lotes.status, ['sending', 'unknown']),
            ),
          )
          .returning({ id: lotes.id });
        if (updated.length !== 1)
          throw new Error(`Lote ${loteId} is not in sending or unknown state`);
        // SIFEN holds the lote: its documents are submitted (HU-E6-03 polls them). Only `queued`
        // ones move; anything else is left alone because failing here would strand the lote in
        // `sending`. After a 0301 or no answer they stay `queued` and can be re-queued.
        if (outcome.status === 'sent') {
          await releaseRecoveryHolds(tx, loteId);
          const submitted = await tx
            .update(documents)
            .set({ status: 'submitted', updatedAt: now() })
            .where(
              and(
                eq(documents.status, 'queued'),
                inArray(
                  documents.id,
                  tx
                    .select({ id: loteDocuments.documentId })
                    .from(loteDocuments)
                    .where(eq(loteDocuments.loteId, loteId)),
                ),
              ),
            )
            .returning({ id: documents.id });
          // Transactional outbox: document.submitted deliveries commit with the status change.
          await enqueueDocumentEvents(tx, {
            tenantId,
            documentIds: submitted.map((row) => row.id),
            at: now(),
          });
        }
        if (outcome.status === 'rejected') await backOff(tx, loteId);
      });
    },
  };

  /**
   * A refused lote leaves its documents `queued` and eligible; count the refusal and make them wait
   * (doubling, capped) or, at the cap, hold them for an operator: they are never dropped.
   */
  async function backOff(tx: Tx, loteId: string): Promise<void> {
    const queued = await tx
      .select({ id: documents.id, attempts: documents.transmissionAttempts })
      .from(documents)
      .where(
        and(
          eq(documents.status, 'queued'),
          inArray(
            documents.id,
            tx
              .select({ id: loteDocuments.documentId })
              .from(loteDocuments)
              .where(eq(loteDocuments.loteId, loteId)),
          ),
        ),
      );
    for (const { id, attempts: before } of queued) {
      const attempts = before + 1;
      const exhausted = attempts >= maxTransmissionAttempts;
      const wait = Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS);
      await tx
        .update(documents)
        .set({
          transmissionAttempts: attempts,
          nextTransmissionAt: exhausted ? null : new Date(now().getTime() + wait),
          ...(exhausted ? { transmissionHold: ATTEMPTS_EXHAUSTED_HOLD } : {}),
          updatedAt: now(),
        })
        .where(eq(documents.id, id));
    }
  }
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

/**
 * SIFEN did receive this lote, so a document the recovery had held as absent (0420) is no longer
 * absent: its hold is cleared as it moves to `submitted`, audited like the operator release.
 */
async function releaseRecoveryHolds(tx: Tx, loteId: string): Promise<void> {
  const released = await tx
    .update(documents)
    .set({ transmissionHold: null })
    .where(
      and(
        eq(documents.status, 'queued'),
        eq(documents.transmissionHold, RECOVERY_UNRESOLVED_HOLD),
        inArray(
          documents.id,
          tx
            .select({ id: loteDocuments.documentId })
            .from(loteDocuments)
            .where(eq(loteDocuments.loteId, loteId)),
        ),
      ),
    )
    .returning({ id: documents.id });
  for (const { id } of released) {
    await recordAudit(tx, {
      actor: TRANSMISSION_WORKER_ACTOR,
      action: 'document.hold_released',
      entity: { type: 'document', id },
      before: { transmissionHold: RECOVERY_UNRESOLVED_HOLD },
      after: { transmissionHold: null },
    });
  }
}
