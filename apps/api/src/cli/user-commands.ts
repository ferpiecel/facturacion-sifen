import { and, count, eq, sql } from 'drizzle-orm';
import { tenantMemberships, tenants, users, type Database } from '@sifen/db';
import { CreateUserUseCase } from '../modules/identity/application/create-user.use-case.js';
import { normalizeEmail } from '../modules/identity/domain/email.js';
import type { PortalRole } from '../modules/identity/domain/portal-role.js';
import { Argon2SecretHasherAdapter } from '../modules/identity/infrastructure/adapters/argon2-secret-hasher.adapter.js';
import { recordAudit } from '../modules/audit/infrastructure/record-audit.js';

const OPERATOR = { type: 'operator', id: 'ops-cli' } as const;

export interface CreatePortalUserParams {
  tenantId: string;
  email: string;
  displayName: string;
  role: PortalRole;
  /** Required for a new user; ignored for an existing one (their password is never touched). */
  password?: string;
}

export interface CreatePortalUserResult {
  userId: string;
  /** False when the email already belonged to a user, who was only added to the tenant. */
  created: boolean;
}

/**
 * Operator CLI handler (HU-E1-07): provisions a portal user in a tenant (invitation-only, PRD step 9).
 * A new email creates the user (policy-checked password, Argon2id hash); an existing one, typically an
 * accountant working for several tenants, is only added to this tenant, and their name and password are
 * left alone (the result says so: `created: false`). A disabled user is refused.
 *
 * One operator-connection transaction does everything, like `revokeCertificate`: the tenant is bound
 * (`app.current_tenant`) so the audit row (`user.created` / `membership.added`, actor `operator`, no
 * credentials) lands in the tenant's log with the user and the membership, or none of it persists. A
 * failure therefore leaves nothing behind and the command can simply be run again; two runs racing on a
 * new email end with one creating the user and the other attaching it (`ON CONFLICT DO NOTHING`).
 */
export async function createPortalUser(
  db: Database,
  params: CreatePortalUserParams,
): Promise<CreatePortalUserResult> {
  const email = normalizeEmail(params.email);
  if (!email) {
    throw new Error('invalid user: invalid_email');
  }
  return db.transaction(async (tx) => {
    const tenant = await tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, params.tenantId));
    if (tenant.length === 0) {
      throw new Error(`tenant not found: ${params.tenantId}`);
    }
    await tx.execute(sql`select set_config('app.current_tenant', ${params.tenantId}, true)`);

    const find = () =>
      tx
        .select({ id: users.id, disabledAt: users.disabledAt })
        .from(users)
        .where(eq(users.email, email));
    let existing = (await find()).at(0);
    let created = false;
    if (existing === undefined) {
      if (params.password === undefined) {
        throw new Error('a password is required to create a new user (pass --password -)');
      }
      const user = await new CreateUserUseCase(new Argon2SecretHasherAdapter()).execute({
        email,
        displayName: params.displayName,
        password: params.password,
      });
      const inserted = await tx
        .insert(users)
        .values(user)
        .onConflictDoNothing()
        .returning({ id: users.id });
      created = inserted.length > 0;
      existing = (await find()).at(0);
    }
    if (existing === undefined) {
      throw new Error('user was not inserted');
    }
    if (existing.disabledAt !== null) {
      throw new Error('the user is disabled; re-enable the account before adding it to a tenant');
    }
    const userId = existing.id;

    const member = await tx
      .select({ id: tenantMemberships.id })
      .from(tenantMemberships)
      .where(
        and(eq(tenantMemberships.tenantId, params.tenantId), eq(tenantMemberships.userId, userId)),
      );
    if (member.length > 0) {
      throw new Error('the user is already a member of this tenant');
    }
    await tx
      .insert(tenantMemberships)
      .values({ tenantId: params.tenantId, userId, role: params.role });
    const [others] = created
      ? [{ total: 0 }]
      : await tx
          .select({ total: count() })
          .from(tenantMemberships)
          .where(eq(tenantMemberships.userId, userId));
    await recordAudit(tx, {
      actor: OPERATOR,
      action: created ? 'user.created' : 'membership.added',
      entity: { type: 'user', id: userId },
      before: null,
      after: created
        ? { email, role: params.role }
        : { email, role: params.role, userExisted: true, otherTenants: others.total - 1 },
    });
    return { userId, created };
  });
}
