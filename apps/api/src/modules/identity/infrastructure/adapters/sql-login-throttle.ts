import { sql } from 'drizzle-orm';
import type { Database } from '@sifen/db';
import type { LoginThrottle, ThrottleLimit } from '../../application/ports/login-throttle.port.js';
import { callFunction, subjectHash } from './sql-auth-support.shared.js';

/** `auth_throttle_*` functions of migration 0040; only the SHA-256 of the subject is stored. */
export class SqlLoginThrottle implements LoginThrottle {
  constructor(private readonly db: Database) {}

  async isLocked(subject: string): Promise<boolean> {
    const rows = await callFunction<{ locked: boolean }>(
      this.db,
      sql`select auth_throttle_locked(${subjectHash(subject)}) as locked`,
    );
    return rows.at(0)?.locked === true;
  }

  async recordFailure(subject: string, limit: ThrottleLimit): Promise<boolean> {
    const rows = await callFunction<{ locked: boolean }>(
      this.db,
      sql`select auth_throttle_fail(${subjectHash(subject)}, ${limit.max}, ${limit.windowSeconds}, ${limit.lockSeconds}) as locked`,
    );
    return rows.at(0)?.locked === true;
  }

  async clear(subject: string): Promise<void> {
    await callFunction(this.db, sql`select auth_throttle_clear(${subjectHash(subject)})`);
  }
}
