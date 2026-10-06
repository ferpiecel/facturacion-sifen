import { sql } from 'drizzle-orm';
import type { Database } from '@sifen/db';
import type {
  UserCredential,
  UserCredentialLookup,
} from '../../application/ports/user-credential-lookup.port.js';
import { callFunction } from './sql-auth-support.shared.js';

/** `resolve_user_credentials` of migration 0040: the pre-authentication read, no `platform_admin` needed. */
export class SqlUserCredentialLookup implements UserCredentialLookup {
  constructor(private readonly db: Database) {}

  async findByEmail(email: string): Promise<UserCredential | null> {
    const rows = await callFunction<{ id: string; password_hash: string; disabled: boolean }>(
      this.db,
      sql`select * from resolve_user_credentials(${email})`,
    );
    const row = rows.at(0);
    return row ? { userId: row.id, passwordHash: row.password_hash, disabled: row.disabled } : null;
  }
}
