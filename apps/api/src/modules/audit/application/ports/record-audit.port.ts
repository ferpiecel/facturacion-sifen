export interface AuditEntry {
  actor: { type: 'api_key' | 'user' | 'operator'; id: string };
  action: string;
  entity: { type: string; id: string };
  before: unknown;
  after: unknown;
}

/**
 * Appends one audit row inside the caller's transaction (`tx`), so it commits
 * or rolls back with the write it describes. The tenant comes from the
 * transaction context, never from the entry.
 */
export type RecordAudit<Tx> = (tx: Tx, entry: AuditEntry) => Promise<void>;
