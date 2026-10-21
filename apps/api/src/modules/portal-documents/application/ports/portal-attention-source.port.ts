import type { PortalDocumentRow } from './portal-document-source.port.js';

export interface AttentionQuery {
  /** Pending documents signed before this instant are past their 72 h window. */
  overdueBefore: Date;
  /** Pending documents signed up to here are overdue or due within 12 h. */
  dueSoonBefore: Date;
  limit: number;
}

export interface PortalAttentionRow extends PortalDocumentRow {
  signedAt: Date | null;
  /** Plain code of why the pipeline stopped on the document; `null` when not held. */
  transmissionHold: string | null;
  /** The stored `sifen_messages` JSON, not yet validated. */
  sifenMessages: unknown;
}

/** Tenant-scoped reads inside the tenant's RLS transaction, current environment only. */
export interface PortalAttentionSource {
  /** At most `limit` candidates, plus how many there are in all. */
  listNeedingAttention(
    tenantId: string,
    query: AttentionQuery,
  ): Promise<{ rows: PortalAttentionRow[]; total: number }>;
}
