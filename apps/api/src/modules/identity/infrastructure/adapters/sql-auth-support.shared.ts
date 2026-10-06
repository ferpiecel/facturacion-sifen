import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withAppRoleTransaction, type Database } from '@sifen/db';

/** SHA-256 hex of a throttled or audited subject (an email, an IP, a user id). */
export const subjectHash = (subject: string): string =>
  createHash('sha256').update(subject).digest('hex');

/** Runs one query on the pre-tenant `app_user` path, where only the SECURITY DEFINER functions exist. */
export async function callFunction<T>(db: Database, query: ReturnType<typeof sql>): Promise<T[]> {
  return withAppRoleTransaction(db, async (tx) => {
    const result = (await tx.execute(query)) as { rows: T[] };
    return result.rows;
  });
}
