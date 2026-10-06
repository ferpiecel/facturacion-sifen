import {
  auditLog,
  createPgliteDatabase,
  tenantMemberships,
  users,
  type DatabaseHandle,
} from '@sifen/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvalidUserError } from '../modules/identity/application/create-user.use-case.js';
import { createTenant } from './commands.js';
import { createPortalUser } from './user-commands.js';

const PASSWORD = 'correct horse battery staple';

describe('createPortalUser (HU-E1-07, operator CLI)', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
  });

  afterAll(async () => {
    await handle.close();
  });

  const params = (tenantId: string, overrides: Record<string, unknown> = {}) => ({
    tenantId,
    email: `u${String(Math.random()).slice(2)}@example.com`,
    displayName: 'Ana',
    role: 'owner' as const,
    password: PASSWORD,
    ...overrides,
  });

  it('creates the user with an Argon2id hash and the membership with its role', async () => {
    const { id: tenantId } = await createTenant(handle.db, 'T1');
    const input = params(tenantId, { email: 'Ana@Example.com', role: 'admin' });

    const result = await createPortalUser(handle.db, input);

    expect(result.created).toBe(true);
    const [user] = await handle.db.select().from(users).where(eq(users.id, result.userId));
    expect(user.email).toBe('ana@example.com');
    expect(user.passwordHash.startsWith('$argon2id$')).toBe(true);
    const memberships = await handle.db
      .select()
      .from(tenantMemberships)
      .where(eq(tenantMemberships.userId, result.userId));
    expect(memberships.map((m) => [m.tenantId, m.role])).toEqual([[tenantId, 'admin']]);
  });

  it('audits as the operator in the tenant, without the password or its hash', async () => {
    const { id: tenantId } = await createTenant(handle.db, 'T2');
    const result = await createPortalUser(handle.db, params(tenantId));

    const rows = await handle.db.select().from(auditLog).where(eq(auditLog.tenantId, tenantId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: 'operator',
      actorId: 'ops-cli',
      action: 'user.created',
      entityType: 'user',
      entityId: result.userId,
    });
    const text = JSON.stringify(rows[0]);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain('argon2');
  });

  it('adds an existing user to a second tenant without touching their password', async () => {
    const { id: a } = await createTenant(handle.db, 'T3a');
    const { id: b } = await createTenant(handle.db, 'T3b');
    const email = 'contador@example.com';
    const first = await createPortalUser(handle.db, params(a, { email }));
    const [before] = await handle.db.select().from(users).where(eq(users.id, first.userId));

    const second = await createPortalUser(handle.db, {
      tenantId: b,
      email,
      displayName: 'ignored',
      role: 'lector',
    });

    expect(second).toEqual({ userId: first.userId, created: false });
    const [after] = await handle.db.select().from(users).where(eq(users.id, first.userId));
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.displayName).toBe('Ana');
    const audit = await handle.db.select().from(auditLog).where(eq(auditLog.tenantId, b));
    expect(audit.map((row) => row.action)).toEqual(['membership.added']);
  });

  it('refuses a user who is already a member of the tenant', async () => {
    const { id: tenantId } = await createTenant(handle.db, 'T4');
    const input = params(tenantId);
    await createPortalUser(handle.db, input);

    await expect(createPortalUser(handle.db, { ...input, role: 'lector' })).rejects.toThrow(
      /already a member/,
    );
  });

  it('requires a password for a new user', async () => {
    const { id: tenantId } = await createTenant(handle.db, 'T5');
    await expect(
      createPortalUser(handle.db, params(tenantId, { password: undefined })),
    ).rejects.toThrow(/password is required/);
  });

  it('rejects a weak password and stores nothing', async () => {
    const { id: tenantId } = await createTenant(handle.db, 'T6');
    const input = params(tenantId, { email: 'weak@example.com', password: 'short' });

    await expect(createPortalUser(handle.db, input)).rejects.toBeInstanceOf(InvalidUserError);
    expect(await handle.db.select().from(users).where(eq(users.email, 'weak@example.com'))).toEqual(
      [],
    );
  });

  it('fails for an unknown tenant and leaves no user behind', async () => {
    const input = params('00000000-0000-4000-8000-000000000000', { email: 'ghost@example.com' });

    await expect(createPortalUser(handle.db, input)).rejects.toThrow();
    expect(
      await handle.db.select().from(users).where(eq(users.email, 'ghost@example.com')),
    ).toEqual([]);
  });
});
