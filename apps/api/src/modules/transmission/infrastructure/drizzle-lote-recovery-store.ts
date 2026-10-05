import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { documents, loteDocuments, lotes, withTenantTransaction, type Database } from '@sifen/db';
import type { LoteRecoveryOutcome, LoteRecoveryStore } from '../application/recover-lote-by-cdc.js';
import { enqueueDocumentEvents } from '../../webhooks/infrastructure/enqueue-document-events.js';
import { settleDocument, type Tx } from './settle-document.js';

/** Hold code of a document whose CDC keeps answering 0420: released with `document:release-hold`. */
export const RECOVERY_UNRESOLVED_HOLD = 'recovery:0420-unresolved';
/**
 * A CDC is held at its third 0420, and never before 48 h after the lote was sent (Guía 2024: a lote
 * is processed within 24 h and queryable for 48 h): one 0420 may only mean "not processed yet", but
 * the same answer three times, 10 minutes apart, after the window is SIFEN saying it does not hold it.
 * The count is the document's `transmission_attempts`, which the release CLI resets, so an operator
 * who releases the hold gets three more passes before it is held again.
 */
const MAX_ABSENT_ANSWERS = 3;
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
            ),
          );
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
        const heldSince = current.sentAt ?? current.createdAt;
        const eligible = guard.recoveredAt.getTime() - heldSince.getTime() >= HOLD_AFTER_MS;
        const held: string[] = [];
        for (const { cdc } of outcome.unresolved.filter((entry) => entry.absent)) {
          const id = await countAbsentAnswer(tx, loteId, cdc, guard.recoveredAt, eligible);
          if (id) held.push(id);
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
              ),
            );
          if ((open.at(0)?.total ?? 0) === 0) {
            await tx
              .update(lotes)
              .set({
                status: 'processed',
                lastPollMessage:
                  `${reasonOf(current.message)} | held for an operator (${RECOVERY_UNRESOLVED_HOLD})`.replace(
                    /^ \| /,
                    '',
                  ),
              })
              .where(eq(lotes.id, loteId));
          }
        }
        return held;
      });
      for (const id of result ?? []) {
        logger?.warn(
          `Document ${id} of tenant ${tenantId} held as ${RECOVERY_UNRESOLVED_HOLD}: its CDC keeps answering 0420`,
        );
      }
      return result !== null;
    },
  };
}

/**
 * Counts one 0420 answer on the document and holds it when the bound is reached; returns its id when
 * it was held. Only a document still waiting for SIFEN (`queued` or `submitted`) and not held counts.
 */
async function countAbsentAnswer(
  tx: Tx,
  loteId: string,
  cdc: string,
  at: Date,
  eligible: boolean,
): Promise<string | null> {
  const doc = (
    await tx
      .select({ id: documents.id, attempts: documents.transmissionAttempts })
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
        ),
      )
  ).at(0);
  if (!doc) return null;
  const attempts = doc.attempts + 1;
  const hold = eligible && attempts >= MAX_ABSENT_ANSWERS;
  await tx
    .update(documents)
    .set({
      transmissionAttempts: attempts,
      ...(hold ? { transmissionHold: RECOVERY_UNRESOLVED_HOLD } : {}),
      updatedAt: at,
    })
    .where(eq(documents.id, doc.id));
  return hold ? doc.id : null;
}

const reasonOf = (message: string | null): string => (message ?? '').split(RECOVERY_NOTE)[0];

/** Marks the start of the recovery's own text in `last_poll_message`; what precedes it is the hand-over reason. */
const RECOVERY_NOTE = ' | recovery: ';

/** The hand-over reason (0364, window elapsed...) is kept; only the recovery note after it is rewritten. */
function columnsFor({ unresolved }: LoteRecoveryOutcome, previous: string | null) {
  const reason = (previous ?? '').split(RECOVERY_NOTE)[0].replace(/^recovery: .*/, '') || null;
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
