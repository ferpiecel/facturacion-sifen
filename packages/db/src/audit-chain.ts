import { sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { MissingTenantContextError } from './errors.js';
import { assertValidTenantId } from './tenant-id.js';

export type AuditChainBreak = {
  id: string;
  seq: number;
  reason: 'hash_mismatch' | 'broken_link' | 'checkpoint_mismatch';
};

export type AuditChainResult =
  | { ok: true; rows: number; headSeq: number; headHash: string }
  | { ok: false; rows: number; brokenAt: AuditChainBreak };

/** A previously trusted point of the chain, e.g. stored outside the database. */
export type AuditChainCheckpoint = { seq: number; hash: string };

export type VerifyAuditChainOptions = {
  checkpoint?: AuditChainCheckpoint;
  /** Rows loaded per keyset page (default 1000). */
  batchSize?: number;
};

const GENESIS_HASH = '0'.repeat(64);
const DEFAULT_BATCH_SIZE = 1000;
const CONTEXT_ROLES = new Set(['platform_admin', 'audit_maintenance']);

type ChainRow = {
  id: string;
  seq: string;
  prev_hash: string;
  hash: string;
  expected_hash: string;
};

async function assertCanSeeTenant(db: Database, tenantId: string): Promise<void> {
  const result = (await db.execute(sql`
    select current_setting('app.current_tenant', true) as ctx, current_user as usr,
      coalesce((select rolsuper or rolbypassrls from pg_roles where rolname = current_user), false) as bypass`)) as {
    rows: { ctx: string | null; usr: string; bypass: boolean }[];
  };
  const session = result.rows.at(0);
  if (!session || session.bypass || CONTEXT_ROLES.has(session.usr) || session.ctx === tenantId) {
    return;
  }
  throw new MissingTenantContextError(tenantId);
}

async function countRows(db: Database, tenantId: string, afterSeq: number): Promise<number> {
  const result = (await db.execute(
    sql`select count(*)::text as count from audit_log where tenant_id = ${tenantId} and seq > ${afterSeq}`,
  )) as { rows: { count: string }[] };
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * Recomputes the tenant's audit hash chain (HU-E13-02, RNF-08) with the same
 * database function the INSERT trigger uses, in keyset batches, and reports
 * the first row whose content or link to its predecessor does not check out.
 *
 * Run it inside `withTenantTransaction` (or as a role that bypasses RLS):
 * a session subject to RLS without the matching tenant context would see no
 * rows, so it throws {@link MissingTenantContextError} rather than report an
 * empty chain as intact.
 *
 * `checkpoint` starts verification after a trusted `{seq, hash}` (for example
 * the previous run's `headSeq`/`headHash`, or the last row before a retention
 * purge). Persist `headSeq`/`headHash` outside the database to anchor the chain.
 *
 * Limits: deleting the tail of the chain (audit_maintenance) or rewriting the
 * whole chain (table owner) leaves a self-consistent chain; both are only
 * detectable by comparing against an externally stored head or checkpoint.
 */
export async function verifyAuditChain(
  db: Database,
  tenantId: string,
  options: VerifyAuditChainOptions = {},
): Promise<AuditChainResult> {
  assertValidTenantId(tenantId);
  await assertCanSeeTenant(db, tenantId);
  const { checkpoint, batchSize = DEFAULT_BATCH_SIZE } = options;

  let expectedPrev = checkpoint?.hash ?? GENESIS_HASH;
  let lastSeq = checkpoint?.seq ?? 0;
  const from = lastSeq;

  if (checkpoint) {
    const stored = (await db.execute(sql`
      select id, hash from audit_log where tenant_id = ${tenantId} and seq = ${checkpoint.seq}`)) as {
      rows: { id: string; hash: string }[];
    };
    const row = stored.rows.at(0);
    if (row && row.hash !== checkpoint.hash) {
      const brokenAt = { id: row.id, seq: checkpoint.seq, reason: 'checkpoint_mismatch' } as const;
      return { ok: false, rows: await countRows(db, tenantId, from), brokenAt };
    }
  }

  for (;;) {
    const result = (await db.execute(sql`
      select id, seq::text as seq, prev_hash, hash,
        audit_log_compute_hash(tenant_id, id, seq, occurred_at, actor_type::text, actor_id,
          action, entity_type, entity_id, before, after, prev_hash) as expected_hash
      from audit_log where tenant_id = ${tenantId} and seq > ${lastSeq}
      order by audit_log.seq limit ${batchSize}`)) as { rows: ChainRow[] };
    const { rows } = result;

    for (const row of rows) {
      const seq = Number(row.seq);
      const linked = row.prev_hash === expectedPrev && seq === lastSeq + 1;
      if (!linked || row.hash !== row.expected_hash) {
        const reason = linked ? 'hash_mismatch' : 'broken_link';
        const total = await countRows(db, tenantId, from);
        return { ok: false, rows: total, brokenAt: { id: row.id, seq, reason } };
      }
      expectedPrev = row.hash;
      lastSeq = seq;
    }
    if (rows.length < batchSize) {
      return { ok: true, rows: lastSeq - from, headSeq: lastSeq, headHash: expectedPrev };
    }
  }
}
