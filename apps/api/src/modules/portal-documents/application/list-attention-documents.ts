import {
  hoursRemaining,
  transmissionDeadline,
  TRANSMISSION_WINDOW_MS,
} from '../../transmission/domain/transmission-deadline.js';
import { parseSifenMessages, rejectionReasonOf } from '../domain/document-events.js';
import { DUE_SOON_MS } from './get-portal-summary.js';
import { toPortalDocumentItem, type PortalDocumentItem } from './portal-document-item.js';
import type {
  PortalAttentionRow,
  PortalAttentionSource,
} from './ports/portal-attention-source.port.js';

/** At most this many documents come back; `total` still counts them all. */
export const ATTENTION_LIMIT = 100;

/** Most urgent first; the order of the values is the order of the list. */
export const ATTENTION_REASONS = ['overdue', 'held', 'rejected', 'due_soon'] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

export interface AttentionItem extends PortalDocumentItem {
  reasons: AttentionReason[];
  /** When the 72 h window ends; `null` for a document that was never signed. */
  deadline: string | null;
  /** Hours left to the deadline, to a tenth; zero once it has passed. */
  hoursRemaining: number | null;
  hold: string | null;
  rejectionReason: string | null;
}

export interface AttentionPage {
  items: AttentionItem[];
  total: number;
  truncated: boolean;
}

const PENDING = new Set(['signed', 'queued', 'submitted']);
const rank = (reason: AttentionReason) => ATTENTION_REASONS.indexOf(reason);

function reasonsOf(row: PortalAttentionRow, deadline: Date | null, now: Date): AttentionReason[] {
  const reasons: AttentionReason[] = [];
  const pending = deadline !== null && PENDING.has(row.status);
  if (pending && deadline.getTime() < now.getTime()) reasons.push('overdue');
  if (row.transmissionHold !== null) reasons.push('held');
  if (row.status === 'rejected') reasons.push('rejected');
  if (
    pending &&
    !reasons.includes('overdue') &&
    deadline.getTime() <= now.getTime() + DUE_SOON_MS
  ) {
    reasons.push('due_soon');
  }
  return reasons;
}

/**
 * HU-E12-04: the active tenant's documents that need the user's action: overdue or soon-due pending ones, held
 * ones and rejected ones, most urgent first.
 */
export function createListAttentionDocuments(deps: {
  source: PortalAttentionSource;
  now: () => Date;
}) {
  return async (tenantId: string): Promise<AttentionPage> => {
    const now = deps.now();
    const { rows, total } = await deps.source.listNeedingAttention(tenantId, {
      overdueBefore: new Date(now.getTime() - TRANSMISSION_WINDOW_MS),
      dueSoonBefore: new Date(now.getTime() - TRANSMISSION_WINDOW_MS + DUE_SOON_MS),
      limit: ATTENTION_LIMIT,
    });

    const items = rows.flatMap((row): AttentionItem[] => {
      const deadline = row.signedAt
        ? new Date(row.signedAt.getTime() + TRANSMISSION_WINDOW_MS)
        : null;
      const reasons = reasonsOf(row, deadline, now);
      if (reasons.length === 0) return [];
      return [
        {
          ...toPortalDocumentItem(row),
          reasons,
          deadline: deadline?.toISOString() ?? null,
          hoursRemaining: deadline
            ? Math.max(0, Math.round((deadline.getTime() - now.getTime()) / 360_000) / 10)
            : null,
          hold: row.transmissionHold,
          rejectionReason: rejectionReasonOf(row.status, parseSifenMessages(row.sifenMessages)),
        },
      ];
    });

    items.sort(
      (a, b) =>
        rank(a.reasons[0]) - rank(b.reasons[0]) ||
        (a.deadline ?? '~').localeCompare(b.deadline ?? '~') ||
        b.issuedAt.localeCompare(a.issuedAt),
    );
    return { items, total, truncated: total > rows.length };
  };
}
