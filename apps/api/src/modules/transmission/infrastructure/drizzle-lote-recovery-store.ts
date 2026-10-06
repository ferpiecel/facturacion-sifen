import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { documents, loteDocuments, lotes, withTenantTransaction, type Database } from '@sifen/db';
import type { LoteRecoveryOutcome, LoteRecoveryStore } from '../application/recover-lote-by-cdc.js';
import { recordAudit } from '../../audit/infrastructure/record-audit.js';
import { enqueueDocumentEvents } from '../../webhooks/infrastructure/enqueue-document-events.js';
import { recoverableInLote } from './recoverable-in-lote.js';
import { settleDocument, type Tx } from './settle-document.js';
import { DEFAULT_MAX_TRANSMISSION_ATTEMPTS } from './transmission-limits.js';
import { TRANSMISSION_WORKER_ACTOR } from './transmission-audit-actor.js';

/** Hold code of a document whose CDC keeps answering 0420: released with `document:release-hold`. */
export const RECOVERY_UNRESOLVED_HOLD = 'recovery:0420-unresolved';
/**
 * A CDC that answers 0420 at least 48 h after the lote was sent is held. Guía 2024: SIFEN processes a
 * lote within 24 h and lote queries are valid for 48 h, so past that window a 0420 is SIFEN saying it
 * does not hold the DE; before it, 0420 may only mean "not processed yet" and is never held. There is
 * deliberately no per-document counter: `transmission_attempts` belongs to the 0301 backoff and must
 * not be shared, and a dedicated column would only add a marginal safety margin over the 48 h bound.
 * The hold is reversible (`document:release-hold`); a released document that still answers 0420 is
 * held again at the next pass.
 */
const HOLD_AFTER_MS = 48 * 60 * 60 * 1000;

export interface DrizzleLoteRecoveryStoreOptions {
  readonly db: Database;
  readonly tenantId: string;
  /** Receives one warning per document held: the alert, until there is a notification channel. */
  readonly logger?: { warn(message: string): void };
}

/** `LoteRecoveryStore` over `lotes`, `lote_documents` and `documents`, run as app_user inside the tenant's transaction. */
export function createDrizzleLoteRecoveryStore({
  db,
  tenantId,
  logger,
}: DrizzleLoteRecoveryStoreOptions): LoteRecoveryStore {
  return {
    async load(loteId) {
      return withTenantTransaction(db, tenantId, async (tx) => {
        const lote = (await tx.select().from(lotes).where(eq(lotes.id, loteId))).at(0);
        if (!lote) return null;
        const pending = await tx
          .select({ cdc: documents.cdc })
          .from(loteDocuments)
          .innerJoin(
            documents,
            and(
              eq(documents.tenantId, loteDocuments.tenantId),
              eq(documents.id, loteDocuments.documentId),
            ),
          )
          .where(
            and(
              eq(loteDocuments.loteId, loteId),
              isNull(documents.transmissionHold),
              // An unknown lote never got a confirmed send: its documents are still queued.
              eq(documents.status, lote.status === 'unknown' ? 'queued' : 'submitted'),
              recoverableInLote(loteId),
            ),
          )
          // Least recently queried first: a capped pass rotates through the lote instead of starving its tail.
          .orderBy(asc(documents.updatedAt), asc(documents.id));
        return {
          loteId: lote.id,
          status: lote.status,
          lastPolledAt: lote.lastPolledAt,
          cdcs: pending.map((row) => row.cdc),
        };
      });
    },

    async record(loteId, outcome, guard) {
      const result = await withTenantTransaction(db, tenantId, async (tx) => {
        const current = (
          await tx
            .select({
              message: lotes.lastPollMessage,
              sendAttemptedAt: lotes.sendAttemptedAt,
              sentAt: lotes.sentAt,
              createdAt: lotes.createdAt,
            })
            .from(lotes)
            .where(eq(lotes.id, loteId))
        ).at(0);
        // Compare-and-set: only the run that still sees the loaded status and query time wins.
        const updated = await tx
          .update(lotes)
          .set({
            ...columnsFor(outcome, current?.message ?? null),
            lastPolledAt: guard.recoveredAt,
            updatedAt: guard.recoveredAt,
          })
          .where(
            and(
              eq(lotes.id, loteId),
              eq(lotes.status, guard.expectedStatus),
              guard.expectedLastPolledAt === null
                ? sql`${lotes.lastPolledAt} IS NULL`
                : // JS dates carry milliseconds; the column may hold microseconds.
                  sql`date_trunc('milliseconds', ${lotes.lastPolledAt}) = ${guard.expectedLastPolledAt}`,
            ),
          )
          .returning({ id: lotes.id });
        if (updated.length !== 1 || !current) return null;
        for (const resolution of outcome.resolutions) {
          if (guard.expectedStatus === 'unknown') {
            await confirmSubmitted(tx, tenantId, loteId, resolution.cdc, guard.recoveredAt);
          }
          await settleDocument(tx, tenantId, loteId, resolution, guard.recoveredAt);
        }
        await touchQueried(
          tx,
          loteId,
          outcome.unresolved.filter((entry) => !entry.skipped).map((entry) => entry.cdc),
          guard.recoveredAt,
        );
        // The window counts from when the send was attempted: a lote may wait pending for days, and
        // SIFEN starts processing only when it is sent. Lotes that predate the stamp fall back to
        // `sent_at`, then (an unanswered send of that time) to their creation.
        const heldSince = current.sendAttemptedAt ?? current.sentAt ?? current.createdAt;
        const eligible = guard.recoveredAt.getTime() - heldSince.getTime() >= HOLD_AFTER_MS;
        const held: string[] = [];
        const resent: Resent[] = [];
        for (const { cdc } of outcome.unresolved.filter((entry) => entry.absent && eligible)) {
          const action = await holdOrResend(tx, loteId, cdc, guard.recoveredAt);
          if (action?.kind === 'hold') held.push(action.id);
          else if (action) resent.push(action);
        }
        // Nothing left to query (every other document settled or held): the lote leaves its status.
        if (outcome.unresolved.length > 0 && guard.expectedStatus !== 'processed') {
          const open = await tx
            .select({ total: count() })
            .from(loteDocuments)
            .innerJoin(
              documents,
              and(
                eq(documents.tenantId, loteDocuments.tenantId),
                eq(documents.id, loteDocuments.documentId),
              ),
            )
            .where(
              and(
                eq(loteDocuments.loteId, loteId),
                inArray(documents.status, ['queued', 'submitted']),
                isNull(documents.transmissionHold),
                recoverableInLote(loteId),
              ),
            );
          if ((open.at(0)?.total ?? 0) === 0) {
            await tx
              .update(lotes)
              .set({
                status: 'processed',
                lastPollMessage: withNote(
                  handOverReason(current.message),
                  held.length > 0
                    ? `held for an operator (${RECOVERY_UNRESOLVED_HOLD})`
                    : 'queued again after 0420 past the window',
                ),
              })
              .where(eq(lotes.id, loteId));
          }
        }
        // After every UPDATE, like `releaseRecoveryHolds`: each audit insert takes the tenant's chain
        // lock, so none is interleaved with the writes above. Same transaction as the holds.
        for (const id of held) {
          await recordAudit(tx, {
            actor: TRANSMISSION_WORKER_ACTOR,
            action: 'document.hold_placed',
            entity: { type: 'document', id },
            before: { transmissionHold: null },
            after: { transmissionHold: RECOVERY_UNRESOLVED_HOLD },
          });
        }
        for (const { id, before, attempts } of resent) {
          await recordAudit(tx, {
            actor: TRANSMISSION_WORKER_ACTOR,
            action: 'document.resend_queued',
            entity: { type: 'document', id },
            before: { status: before, transmissionAttempts: attempts - 1 },
            after: { status: 'queued', transmissionAttempts: attempts },
          });
        }
        return held;
      });
      for (const id of result ?? []) {
        // The commit already happened: a failing logger must not turn a recorded pass into an error.
        try {
          logger?.warn(
            `Document ${id} of tenant ${tenantId} held as ${RECOVERY_UNRESOLVED_HOLD}: its CDC keeps answering 0420`,
          );
        } catch {
          // The hold is in the database and in the worker's held-documents report.
        }
      }
      return result !== null;
    },
  };
}

/** Stamps the documents this pass asked about, so the next capped pass starts with the ones it did not. */
async function touchQueried(
  tx: Tx,
  loteId: string,
  cdcs: readonly string[],
  at: Date,
): Promise<void> {
  if (cdcs.length === 0) return;
  await tx
    .update(documents)
    .set({ updatedAt: at })
    .where(
      and(
        inArray(documents.cdc, [...cdcs]),
        inArray(documents.status, ['queued', 'submitted']),
        recoverableInLote(loteId),
        inArray(
          documents.id,
          tx
            .select({ id: loteDocuments.documentId })
            .from(loteDocuments)
            .where(eq(loteDocuments.loteId, loteId)),
        ),
      ),
    );
}

interface Resent {
  readonly kind: 'resend';
  readonly id: string;
  /** Status before: `submitted` (queued again by the guard's one door) or `queued` (unanswered send). */
  readonly before: string;
  readonly attempts: number;
}

/**
 * A CDC answered 0420 past the 48 h window (the caller checked): SIFEN does not hold the DE, and the
 * Guía says to send it again with the same CDC. The first time (`resent_at` empty, attempts below the
 * 0301 cap) the document is queued again: stamped, counted, `submitted -> queued` through the guard's
 * audited door; the pre-send check verifies it once more before it joins a lote. Otherwise it is held
 * for an operator. Only a document still waiting for SIFEN and not held is touched. The caller audits.
 */
async function holdOrResend(
  tx: Tx,
  loteId: string,
  cdc: string,
  at: Date,
): Promise<{ kind: 'hold'; id: string } | Resent | null> {
  const doc = (
    await tx
      .select({
        id: documents.id,
        status: documents.status,
        attempts: documents.transmissionAttempts,
        resentAt: documents.resentAt,
      })
      .from(documents)
      .innerJoin(
        loteDocuments,
        and(
          eq(loteDocuments.tenantId, documents.tenantId),
          eq(loteDocuments.documentId, documents.id),
        ),
      )
      .where(
        and(
          eq(loteDocuments.loteId, loteId),
          eq(documents.cdc, cdc),
          inArray(documents.status, ['queued', 'submitted']),
          isNull(documents.transmissionHold),
          recoverableInLote(loteId),
        ),
      )
  ).at(0);
  if (!doc) return null;
  if (doc.resentAt === null && doc.attempts + 1 < DEFAULT_MAX_TRANSMISSION_ATTEMPTS) {
    const attempts = doc.attempts + 1;
    await tx
      .update(documents)
      // `now()`: the stamp and the lote creation time share the database clock, which orders them.
      .set({
        status: 'queued',
        resentAt: sql`now()`,
        transmissionAttempts: attempts,
        updatedAt: at,
      })
      .where(eq(documents.id, doc.id));
    return { kind: 'resend', id: doc.id, before: doc.status, attempts };
  }
  await tx
    .update(documents)
    .set({ transmissionHold: RECOVERY_UNRESOLVED_HOLD, updatedAt: at })
    .where(eq(documents.id, doc.id));
  return { kind: 'hold', id: doc.id };
}

/** Marks the start of the recovery's own text in `last_poll_message`; what precedes it is the hand-over reason. */
const RECOVERY_NOTE = ' | recovery: ';

/** The hand-over reason (0364, window elapsed...): what precedes the recovery note, or nothing if there is none. */
function handOverReason(message: string | null): string | null {
  return (message ?? '').split(RECOVERY_NOTE)[0].replace(/^recovery: .*/, '') || null;
}

const withNote = (reason: string | null, note: string): string =>
  reason === null ? note : `${reason} | ${note}`;

/** The hand-over reason is kept; only the recovery note after it is rewritten. */
function columnsFor({ unresolved }: LoteRecoveryOutcome, previous: string | null) {
  const reason = handOverReason(previous);
  if (unresolved.length === 0) return { status: 'processed', lastPollMessage: reason };
  const note = `${String(unresolved.length)} document(s) still unresolved by CDC query`;
  return {
    lastPollMessage: reason === null ? `recovery: ${note}` : `${reason}${RECOVERY_NOTE}${note}`,
  };
}

/**
 * SIFEN answered for a document of an unanswered send: the lote did reach it, so the document goes
 * `queued -> submitted` (and says so) just before it is approved.
 */
async function confirmSubmitted(
  tx: Tx,
  tenantId: string,
  loteId: string,
  cdc: string,
  at: Date,
): Promise<void> {
  const confirmed = await tx
    .update(documents)
    .set({ status: 'submitted', updatedAt: at })
    .where(
      and(
        eq(documents.cdc, cdc),
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
  await enqueueDocumentEvents(tx, { tenantId, documentIds: confirmed.map((row) => row.id), at });
}
