import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../src/client.js';
import { tenants, userMfa, users } from '../src/schema.js';
import { withTenantTransaction } from '../src/tenant-transaction.js';
import { createTestDatabase, queryRows } from './support/harness.js';

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA';
const SEALED = {
  v: 1,
  keyId: 'k',
  wrappedKey: 'AA==',
  nonce: 'AA==',
  tag: 'AA==',
  ciphertext: 'AA==',
};
const CODE_HASH = 'a'.repeat(64);

async function causeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : String(cause);
  }
  return expect.unreachable('expected the query to reject');
}

/** Spec: HU-E1-07 (DB part). One MFA enrolment per user; the secret exists only sealed. */
describe('user_mfa', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function seed() {
    handle = await createTestDatabase();
    const db = handle.db;
    const [ana, bob] = (
      await db
        .insert(users)
        .values([
          { email: 'ana@example.com', passwordHash: HASH, displayName: 'Ana' },
          { email: 'bob@example.com', passwordHash: HASH, displayName: 'Bob' },
        ])
        .returning()
    ).map((row) => row.id);
    return { db, ana: ana, bob: bob };
  }

  it('keeps the TOTP secret only inside sealed, with no clear-text column', async () => {
    const { db } = await seed();
    const columns = await queryRows<{ column_name: string }>(
      db,
      sql`select column_name from information_schema.columns where table_name = 'user_mfa' order by column_name`,
    );
    expect(columns.map((c) => c.column_name)).toEqual(
      [
        'confirmed_at',
        'consecutive_failures',
        'created_at',
        'last_used_step',
        'mfa_locked_at',
        'recovery_hashes',
        'sealed',
        'updated_at',
        'user_id',
      ].sort(),
    );
  });

  it('allows one enrolment per user, starting unconfirmed with no recovery codes', async () => {
    const { db, ana } = await seed();
    await db.insert(userMfa).values({ userId: ana, sealed: SEALED });
    const [row] = await db.select().from(userMfa);
    expect(row).toMatchObject({ confirmedAt: null, lastUsedStep: null, recoveryHashes: [] });
    expect(await causeOf(db.insert(userMfa).values({ userId: ana, sealed: SEALED }))).toContain(
      'user_mfa_pkey',
    );
  });

  it('refuses malformed or excessive recovery hashes and a step without confirmation', async () => {
    const { db, ana, bob } = await seed();
    expect(
      await causeOf(
        db.insert(userMfa).values({ userId: ana, sealed: SEALED, recoveryHashes: ['not-hex'] }),
      ),
    ).toContain('user_mfa_recovery_hashes_valid');
    expect(
      await causeOf(
        db.insert(userMfa).values({
          userId: ana,
          sealed: SEALED,
          recoveryHashes: Array(11).fill(CODE_HASH) as string[],
        }),
      ),
    ).toContain('user_mfa_recovery_hashes_valid');
    expect(
      await causeOf(db.insert(userMfa).values({ userId: bob, sealed: SEALED, lastUsedStep: 5 })),
    ).toContain('user_mfa_step_needs_confirmation');
  });

  it('never changes the sealed secret once confirmed, and never lowers the step', async () => {
    const { db, ana } = await seed();
    await db.insert(userMfa).values({ userId: ana, sealed: SEALED });
    await db.update(userMfa).set({ sealed: { ...SEALED, keyId: 'k2' } });
    await db
      .update(userMfa)
      .set({ confirmedAt: new Date(), lastUsedStep: 10, recoveryHashes: [CODE_HASH] });
    expect(await causeOf(db.update(userMfa).set({ sealed: SEALED }))).toContain(
      'sealed secret is immutable',
    );
    expect(await causeOf(db.update(userMfa).set({ lastUsedStep: 9 }))).toContain(
      'last_used_step cannot decrease',
    );
    expect(await causeOf(db.update(userMfa).set({ confirmedAt: null }))).toContain(
      'confirmed_at is write-once',
    );
  });

  it('forces RLS and gives app_user no access (a user is global, not tenant data)', async () => {
    const { db } = await seed();
    const [row] = await queryRows<{ forced: boolean; enabled: boolean }>(
      db,
      sql`select relforcerowsecurity as forced, relrowsecurity as enabled from pg_class where relname = 'user_mfa'`,
    );
    expect(row).toEqual({ forced: true, enabled: true });
    const [tenant] = await db.insert(tenants).values({ name: 'T' }).returning();
    expect(
      await causeOf(
        withTenantTransaction(db, (tenant as { id: string }).id, (tx) => tx.select().from(userMfa)),
      ),
    ).toContain('permission denied for table user_mfa');
  });

  it('cannot erase the replay guard by setting last_used_step to NULL', async () => {
    const { db, ana } = await seed();
    await db.insert(userMfa).values({ userId: ana, sealed: SEALED });
    await db.update(userMfa).set({ confirmedAt: new Date(), lastUsedStep: 10 });
    expect(await causeOf(db.update(userMfa).set({ lastUsedStep: null }))).toContain(
      'last_used_step cannot decrease',
    );
  });

  it('lets recovery hashes only shrink once confirmed, never resurrect a consumed one', async () => {
    const { db, ana } = await seed();
    const other = 'b'.repeat(64);
    await db.insert(userMfa).values({ userId: ana, sealed: SEALED });
    await db
      .update(userMfa)
      .set({ confirmedAt: new Date(), lastUsedStep: 1, recoveryHashes: [CODE_HASH, other] });
    await db.update(userMfa).set({ recoveryHashes: [other] });
    expect(await causeOf(db.update(userMfa).set({ recoveryHashes: [other, CODE_HASH] }))).toContain(
      'recovery_hashes can only shrink',
    );
    expect(await causeOf(db.update(userMfa).set({ recoveryHashes: ['c'.repeat(64)] }))).toContain(
      'recovery_hashes can only shrink',
    );
  });

  it('rejects a NULL element in the recovery hashes', async () => {
    const { db, ana } = await seed();
    expect(
      await causeOf(
        db.execute(
          sql`insert into user_mfa (user_id, sealed, recovery_hashes) values (${ana}, ${JSON.stringify(SEALED)}::jsonb, array[null]::text[])`,
        ),
      ),
    ).toContain('user_mfa_recovery_hashes_valid');
  });
});
