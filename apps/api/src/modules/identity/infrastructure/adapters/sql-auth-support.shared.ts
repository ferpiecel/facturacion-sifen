import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withAppRoleTransaction, type Database } from '@sifen/db';

/**
 * HMAC-SHA256 hex of a throttled or audited subject (an email, an IP, a user id) under the secret pepper.
 * Still personal data (a pseudonym), but not reversible by a dictionary without the pepper.
 */
export const subjectHash = (subject: string, pepper: Buffer): string =>
  createHmac('sha256', pepper).update(subject).digest('hex');

/** Runs one query on the pre-tenant `app_user` path, where only the SECURITY DEFINER functions exist. */
export async function callFunction<T>(db: Database, query: ReturnType<typeof sql>): Promise<T[]> {
  return withAppRoleTransaction(db, async (tx) => {
    const result = (await tx.execute(query)) as { rows: T[] };
    return result.rows;
  });
}
