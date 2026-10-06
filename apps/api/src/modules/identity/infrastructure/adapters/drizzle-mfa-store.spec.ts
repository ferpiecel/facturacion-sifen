import { createPgliteDatabase, users, type DatabaseHandle } from '@sifen/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SealedSecret } from '../../../custody/domain/sealed-secret.js';
import { DrizzleMfaStore } from './drizzle-mfa-store.js';

const SEALED: SealedSecret = {
  v: 1,
  keyId: 'k',
  wrappedKey: 'AA==',
  nonce: 'AA==',
  tag: 'AA==',
  ciphertext: 'AA==',
};
const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA';
const hex = (char: string) => char.repeat(64);

describe('DrizzleMfaStore (HU-E1-07)', () => {
  let handle: DatabaseHandle;
  let store: DrizzleMfaStore;
  let counter = 0;

  beforeAll(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    store = new DrizzleMfaStore(handle.db);
  });

  afterAll(async () => {
    await handle.close();
  });

  async function newUser(): Promise<string> {
    counter += 1;
    const [row] = await handle.db
      .insert(users)
      .values({ email: `u${String(counter)}@example.com`, passwordHash: HASH, displayName: 'U' })
      .returning({ id: users.id });
    return row.id;
  }

  it('finds nothing for a user without enrolment', async () => {
    await expect(store.find(await newUser())).resolves.toBeNull();
  });

  it('saves a pending enrolment, replaces it, and reads it back', async () => {
    const id = await newUser();
    await store.savePending(id, SEALED);
    await store.savePending(id, { ...SEALED, keyId: 'k2' });
    expect(await store.find(id)).toEqual({
      sealed: { ...SEALED, keyId: 'k2' },
      confirmedAt: null,
      lastUsedStep: null,
      recoveryHashes: [],
    });
  });

  it('confirms once, storing the step and the hashed recovery codes', async () => {
    const id = await newUser();
    await store.savePending(id, SEALED);
    await expect(store.confirm(id, 100, [hex('a'), hex('b')], SEALED)).resolves.toBe(true);
    await expect(store.confirm(id, 101, [hex('c')], SEALED)).resolves.toBe(false);
    const row = await store.find(id);
    expect(row).toMatchObject({ lastUsedStep: 100, recoveryHashes: [hex('a'), hex('b')] });
    expect(row?.confirmedAt).toBeInstanceOf(Date);
  });

  it('refuses to replace a confirmed enrolment with a pending one', async () => {
    const id = await newUser();
    await store.savePending(id, SEALED);
    await store.confirm(id, 1, [], SEALED);
    await expect(store.savePending(id, { ...SEALED, keyId: 'other' })).rejects.toThrow(
      /already confirmed/,
    );
    expect((await store.find(id))?.sealed.keyId).toBe('k');
  });

  it('advances the step only forward, atomically', async () => {
    const id = await newUser();
    await store.savePending(id, SEALED);
    await store.confirm(id, 10, [], SEALED);
    await expect(store.advanceStep(id, 11)).resolves.toBe(true);
    await expect(store.advanceStep(id, 11)).resolves.toBe(false);
    await expect(store.advanceStep(id, 5)).resolves.toBe(false);
    const results = await Promise.all([store.advanceStep(id, 20), store.advanceStep(id, 20)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await expect(store.advanceStep(await newUser(), 1)).resolves.toBe(false);
  });

  it('consumes a recovery hash exactly once', async () => {
    const id = await newUser();
    await store.savePending(id, SEALED);
    await store.confirm(id, 1, [hex('a'), hex('b')], SEALED);
    await expect(store.consumeRecoveryCode(id, hex('a'))).resolves.toBe(true);
    await expect(store.consumeRecoveryCode(id, hex('a'))).resolves.toBe(false);
    await expect(store.consumeRecoveryCode(id, hex('z'))).resolves.toBe(false);
    expect((await store.find(id))?.recoveryHashes).toEqual([hex('b')]);
  });

  it('removes an enrolment so the user can enrol anew', async () => {
    const id = await newUser();
    await store.savePending(id, SEALED);
    await store.confirm(id, 1, [], SEALED);
    await store.remove(id);
    expect(await store.find(id)).toBeNull();
    await store.savePending(id, { ...SEALED, keyId: 'fresh' });
    expect((await store.find(id))?.sealed.keyId).toBe('fresh');
  });

  it('confirms only the secret the code was checked against', async () => {
    const id = await newUser();
    await store.savePending(id, SEALED);
    const verified = SEALED;
    await store.savePending(id, { ...SEALED, keyId: 'replaced-by-a-concurrent-enrol' });

    await expect(store.confirm(id, 1, [], verified)).resolves.toBe(false);
    expect((await store.find(id))?.confirmedAt).toBeNull();
  });

  it('spends a recovery code once when two logins race with it', async () => {
    const id = await newUser();
    await store.savePending(id, SEALED);
    await store.confirm(id, 1, [hex('a')], SEALED);
    const results = await Promise.all([
      store.consumeRecoveryCode(id, hex('a')),
      store.consumeRecoveryCode(id, hex('a')),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
