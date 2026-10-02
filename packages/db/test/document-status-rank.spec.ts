import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { DOCUMENT_STATUSES } from '../src/schema.js';
import { createTestDatabase } from './support/harness.js';

/** Spec: HU-E6-03. A status added to DOCUMENT_STATUSES must be ranked on purpose, never by a catch-all. */
describe('documents_status_rank', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  const rank = async (status: string): Promise<number | null> => {
    handle ??= await createTestDatabase();
    const result = await handle.db.execute(
      sql`select public.documents_status_rank(${status}) as rank`,
    );
    return (result as { rows: { rank: number | null }[] }).rows[0].rank;
  };

  it.each(DOCUMENT_STATUSES)('ranks the %s status', async (status) => {
    expect(await rank(status)).not.toBeNull();
  });

  it('has no rank for an unknown status', async () => {
    expect(await rank('bogus')).toBeNull();
  });
});
