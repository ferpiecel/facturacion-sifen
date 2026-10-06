import { sql } from 'drizzle-orm';
import type { Database } from '@sifen/db';
import type { LoginThrottle, ThrottleLimit } from '../../application/ports/login-throttle.port.js';
import { callFunction, subjectHash } from './sql-auth-support.shared.js';

/** `auth_throttle_reserve` / `auth_throttle_clear` of migration 0040; only the peppered HMAC of the subject is stored. */
export class SqlLoginThrottle implements LoginThrottle {
  constructor(
    private readonly db: Database,
    private readonly pepper: Buffer,
  ) {}

  async reserve(subject: string, limit: ThrottleLimit): Promise<boolean> {
    const rows = await callFunction<{ ok: boolean }>(
      this.db,
      sql`select auth_throttle_reserve(${subjectHash(subject, this.pepper)}, ${limit.max}, ${limit.windowSeconds}, ${limit.lockSeconds}) as ok`,
    );
    return rows.at(0)?.ok === true;
  }

  async clear(subject: string): Promise<void> {
    await callFunction(
      this.db,
      sql`select auth_throttle_clear(${subjectHash(subject, this.pepper)})`,
    );
  }
}
