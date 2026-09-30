import { sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { assertValidTenantId } from './tenant-id.js';

export type AuditChainBreak = {
  id: string;
  seq: number;
  reason: 'hash_mismatch' | 'broken_link';
};

export type AuditChainResult =
  { ok: true; rows: number } | { ok: false; rows: number; brokenAt: AuditChainBreak };

const GENESIS_HASH = '0'.repeat(64);

type ChainRow = {
  id: string;
  seq: string;
  prev_hash: string;
  hash: string;
  expected_hash: string;
};

/**
 * Recomputes the tenant's audit hash chain (HU-E13-02, RNF-08) with the same
 * database function the INSERT trigger uses, and reports the first row whose
 * content or link to its predecessor does not check out. Run it on a handle
 * that can read the tenant's rows (tenant transaction or platform role).
 */
export async function verifyAuditChain(db: Database, tenantId: string): Promise<AuditChainResult> {
  assertValidTenantId(tenantId);
  const result = await db.execute(sql`
    select id, seq::text as seq, prev_hash, hash,
      audit_log_compute_hash(tenant_id, id, seq, occurred_at, actor_type::text, actor_id,
        action, entity_type, entity_id, before, after, prev_hash) as expected_hash
    from audit_log where tenant_id = ${tenantId} order by audit_log.seq`);
  const rows = result.rows as ChainRow[];

  let expectedPrev = GENESIS_HASH;
  let expectedSeq = 1;
  for (const row of rows) {
    const seq = Number(row.seq);
    const linked = row.prev_hash === expectedPrev && seq === expectedSeq;
    if (!linked || row.hash !== row.expected_hash) {
      const reason = linked ? 'hash_mismatch' : 'broken_link';
      return { ok: false, rows: rows.length, brokenAt: { id: row.id, seq, reason } };
    }
    expectedPrev = row.hash;
    expectedSeq += 1;
  }
  return { ok: true, rows: rows.length };
}
