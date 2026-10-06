import { authEvents, createPgliteDatabase, users, type DatabaseHandle } from '@sifen/db';
import { createHash, createHmac } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqlAuthEventLog } from './sql-auth-event-log.js';
import { SqlLoginThrottle } from './sql-login-throttle.js';
import { SqlUserCredentialLookup } from './sql-user-credential-lookup.js';

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA';
const LIMIT = { max: 2, windowSeconds: 900, lockSeconds: 900 };
const PEPPER = Buffer.alloc(32, 7);

describe('SQL login support adapters (HU-E1-07 S4)', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
  });

  afterAll(async () => {
    await handle.close();
  });

  it('throttles by a PEPPERED hash: neither the raw subject nor its plain SHA-256 is stored', async () => {
    const throttle = new SqlLoginThrottle(handle.db, PEPPER);
    await throttle.reserve('pepper-probe@example.com', LIMIT);
    const plain = createHash('sha256').update('pepper-probe@example.com').digest('hex');
    const peppered = createHmac('sha256', PEPPER).update('pepper-probe@example.com').digest('hex');
    const rows = JSON.stringify(await handle.db.execute(sql`select key from auth_throttle`));
    expect(rows).toContain(peppered);
    expect(rows).not.toContain(plain);
  });

  it('throttles by a hashed subject: the raw email or IP never reaches the database', async () => {
    const throttle = new SqlLoginThrottle(handle.db, PEPPER);
    const key = 'ana@example.com';
    expect(await throttle.reserve(key, LIMIT)).toBe(true);
    expect(await throttle.reserve(key, LIMIT)).toBe(true);
    expect(await throttle.reserve(key, LIMIT)).toBe(false);
    expect(await throttle.reserve('someone-else', LIMIT)).toBe(true);
    await throttle.clear(key);
    expect(await throttle.reserve(key, LIMIT)).toBe(true);
    const rows = await handle.db.execute(sql`select key from auth_throttle`);
    expect(JSON.stringify(rows)).not.toContain('ana@example.com');
  });

  it('records auth events with a hashed subject and a user when known', async () => {
    const [user] = await handle.db
      .insert(users)
      .values({ email: 'evt@example.com', passwordHash: HASH, displayName: 'E' })
      .returning({ id: users.id });
    const log = new SqlAuthEventLog(handle.db, PEPPER);
    await log.record({
      event: 'login.succeeded',
      userId: user.id,
      subject: 'evt@example.com',
    });
    await log.record({
      event: 'login.password_failed',
      userId: null,
      subject: 'ghost@example.com',
      detail: { step: 'password' },
    });
    const rows = await handle.db.select().from(authEvents);
    expect(rows.map((r) => r.event).sort()).toEqual(['login.password_failed', 'login.succeeded']);
    expect(JSON.stringify(rows)).not.toContain('example.com');
    expect(rows.find((r) => r.event === 'login.succeeded')?.userId).toBe(user.id);
    expect(rows.find((r) => r.event === 'login.password_failed')?.detail).toEqual({
      step: 'password',
    });
    expect(
      await handle.db.select().from(authEvents).where(eq(authEvents.userId, user.id)),
    ).toHaveLength(1);
  });

  it('finds credentials by email and reports a disabled account', async () => {
    const lookup = new SqlUserCredentialLookup(handle.db);
    const [user] = await handle.db
      .insert(users)
      .values({ email: 'cred@example.com', passwordHash: HASH, displayName: 'C' })
      .returning({ id: users.id });
    expect(await lookup.findByEmail('cred@example.com')).toEqual({
      userId: user.id,
      passwordHash: HASH,
      disabled: false,
    });
    await handle.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, user.id));
    expect((await lookup.findByEmail('cred@example.com'))?.disabled).toBe(true);
    expect(await lookup.findByEmail('nobody@example.com')).toBeNull();
  });
});
