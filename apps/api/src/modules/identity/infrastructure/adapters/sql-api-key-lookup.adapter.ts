import { withAppRoleTransaction, type Database } from '@sifen/db';
import { sql } from 'drizzle-orm';
import type {
  ApiKeyLookup,
  ResolvedApiKeyRecord,
} from '../../application/ports/api-key-lookup.port.js';
import type { ApiKeyEnvironment } from '../../domain/api-key.js';

interface ResolveApiKeyRow {
  id: string;
  tenant_id: string;
  secret_hash: string;
  scopes: string[];
  environment: string;
}

/**
 * Calls the `resolve_api_key` / `touch_api_key_last_used` SECURITY DEFINER
 * SQL functions (migration `0003_api_keys_rls.sql`) through the pre-tenant
 * `withAppRoleTransaction` path — never a direct query against `api_keys`.
 */
export class SqlApiKeyLookupAdapter implements ApiKeyLookup {
  constructor(private readonly db: Database) {}

  async resolveByKeyId(keyId: string): Promise<ResolvedApiKeyRecord | null> {
    const rows = await withAppRoleTransaction(this.db, async (tx) => {
      const result = (await tx.execute(sql`select * from resolve_api_key(${keyId})`)) as {
        rows: ResolveApiKeyRow[];
      };
      return result.rows;
    });

    const row = rows.at(0);
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      tenantId: row.tenant_id,
      secretHash: row.secret_hash,
      scopes: row.scopes,
      environment: row.environment as ApiKeyEnvironment,
    };
  }

  async touchLastUsed(id: string): Promise<void> {
    try {
      await withAppRoleTransaction(this.db, (tx) =>
        tx.execute(sql`select touch_api_key_last_used(${id}::uuid)`),
      );
    } catch (error) {
      // Best-effort: never fails the caller's authentication.
      console.error('touch_api_key_last_used failed', error);
    }
  }
}
