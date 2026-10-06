import {
  auditLog,
  createPgliteDatabase,
  tenantMemberships,
  users,
  type DatabaseHandle,
} from '@sifen/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTenant } from './commands.js';

const failing = vi.hoisted(() => ({ next: false }));

vi.mock('../modules/audit/infrastructure/record-audit.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../modules/audit/infrastructure/record-audit.js')>();
  return {
    ...actual,
    recordAudit: (...args: Parameters<typeof actual.recordAudit>) => {
      if (failing.next) {
        failing.next = false;
        return Promise.reject(new Error('audit unavailable'));
      }
      return actual.recordAudit(...args);
    },
  };
});

const { createPortalUser } = await import('./user-commands.js');

describe('createPortalUser is atomic and safe to retry (HU-E1-07)', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
  });

  afterAll(async () => {
    await handle.close();
  });

  const input = (tenantId: string, email: string, password = 'correct horse battery staple') => ({
    tenantId,
    email,
    displayName: 'Ana',
    role: 'owner' as const,
    password,
  });

  it('leaves no user behind when the membership or its audit fails, and the retry audits user.created', async () => {
    const { id: tenantId } = await createTenant(handle.db, 'Atomic');
    failing.next = true;

    await expect(createPortalUser(handle.db, input(tenantId, 'retry@example.com'))).rejects.toThrow(
      'audit unavailable',
    );
    expect(
      await handle.db.select().from(users).where(eq(users.email, 'retry@example.com')),
    ).toEqual([]);

    const retried = await createPortalUser(
      handle.db,
      input(tenantId, 'retry@example.com', 'a different but fine passphrase'),
    );
    expect(retried.created).toBe(true);
    const audit = await handle.db.select().from(auditLog).where(eq(auditLog.tenantId, tenantId));
    expect(audit.map((row) => row.action)).toEqual(['user.created']);
  });

  it('refuses to attach a disabled user and changes nothing', async () => {
    const { id: a } = await createTenant(handle.db, 'DisabledA');
    const { id: b } = await createTenant(handle.db, 'DisabledB');
    const { userId } = await createPortalUser(handle.db, input(a, 'off@example.com'));
    await handle.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, userId));

    await expect(
      createPortalUser(handle.db, { ...input(b, 'off@example.com'), password: undefined }),
    ).rejects.toThrow(/disabled/);
    expect(
      await handle.db.select().from(tenantMemberships).where(eq(tenantMemberships.tenantId, b)),
    ).toEqual([]);
  });

  it('records on membership.added that the account already existed and how many tenants it had', async () => {
    const { id: a } = await createTenant(handle.db, 'ExistsA');
    const { id: b } = await createTenant(handle.db, 'ExistsB');
    await createPortalUser(handle.db, input(a, 'multi@example.com'));

    await createPortalUser(handle.db, { ...input(b, 'multi@example.com'), password: undefined });

    const [row] = await handle.db.select().from(auditLog).where(eq(auditLog.tenantId, b));
    expect(row?.after).toEqual({
      email: 'multi@example.com',
      role: 'owner',
      userExisted: true,
      otherTenants: 1,
    });
  });
});
