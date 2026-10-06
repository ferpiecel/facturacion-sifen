import { sql } from 'drizzle-orm';
import type { Database } from '@sifen/db';
import type { MfaAttemptGuard } from '../../application/ports/mfa-attempt-guard.port.js';
import { callFunction } from './sql-auth-support.shared.js';

/**
 * `mfa_attempt_reserve` / `mfa_attempt_succeeded` of migration 0041, bound to the SHA-256 of one pending session
 * token: the functions resolve the user from that live pending session themselves, so this adapter (and a
 * compromised runtime) cannot count against, lock or reset a user it holds no pending token for.
 */
export class SqlMfaAttemptGuard implements MfaAttemptGuard {
  constructor(
    private readonly db: Database,
    private readonly cap: number,
    private readonly pendingHash: string,
  ) {}

  async reserve(): Promise<boolean> {
    const rows = await callFunction<{ ok: boolean }>(
      this.db,
      sql`select mfa_attempt_reserve(${this.pendingHash}, ${this.cap}) as ok`,
    );
    return rows.at(0)?.ok === true;
  }

  async succeeded(): Promise<void> {
    await callFunction(this.db, sql`select mfa_attempt_succeeded(${this.pendingHash})`);
  }
}
