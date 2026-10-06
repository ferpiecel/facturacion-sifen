import { sql } from 'drizzle-orm';
import type { Database } from '@sifen/db';
import type { MfaAttemptGuard } from '../../application/ports/mfa-attempt-guard.port.js';
import { callFunction } from './sql-auth-support.shared.js';

/** `mfa_attempt_reserve` / `mfa_attempt_succeeded` of migration 0041, on the pre-tenant `app_user` path. */
export class SqlMfaAttemptGuard implements MfaAttemptGuard {
  constructor(
    private readonly db: Database,
    private readonly cap: number,
  ) {}

  async reserve(userId: string): Promise<boolean> {
    const rows = await callFunction<{ ok: boolean }>(
      this.db,
      sql`select mfa_attempt_reserve(${userId}, ${this.cap}) as ok`,
    );
    return rows.at(0)?.ok === true;
  }

  async succeeded(userId: string): Promise<void> {
    await callFunction(this.db, sql`select mfa_attempt_succeeded(${userId})`);
  }
}
