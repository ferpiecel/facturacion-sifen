import { and, eq } from 'drizzle-orm';
import { tenantMemberships, tenants, users, withTenantTransaction, type Database } from '@sifen/db';
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
 * accountant working for several tenants, is only added to this tenant. The membership and its audit
 * row (`user.created` / `membership.added`, actor `operator`, no credentials) are written in the
 * tenant's transaction. `audit_log` is per tenant, hence the required `--tenant`.
 */
export async function createPortalUser(
  db: Database,
  params: CreatePortalUserParams,
): Promise<CreatePortalUserResult> {
  const email = normalizeEmail(params.email);
  if (!email) {
    throw new Error('invalid user: invalid_email');
  }
  const tenant = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, params.tenantId));
  if (tenant.length === 0) {
    throw new Error(`tenant not found: ${params.tenantId}`);
  }

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  let userId = existing.at(0)?.id;
  const created = userId === undefined;
  if (userId === undefined) {
    if (params.password === undefined) {
      throw new Error('a password is required to create a new user (pass --password -)');
    }
    const user = await new CreateUserUseCase(new Argon2SecretHasherAdapter()).execute({
      email,
      displayName: params.displayName,
      password: params.password,
    });
    const inserted = await db.insert(users).values(user).returning({ id: users.id });
    const row = inserted.at(0);
    if (!row) {
      throw new Error('user was not inserted');
    }
    userId = row.id;
  }
  const memberId = userId;

  await withTenantTransaction(db, params.tenantId, async (tx) => {
    const member = await tx
      .select({ id: tenantMemberships.id })
      .from(tenantMemberships)
      .where(
        and(
          eq(tenantMemberships.tenantId, params.tenantId),
          eq(tenantMemberships.userId, memberId),
        ),
      );
    if (member.length > 0) {
      throw new Error('the user is already a member of this tenant');
    }
    await tx
      .insert(tenantMemberships)
      .values({ tenantId: params.tenantId, userId: memberId, role: params.role });
    await recordAudit(tx, {
      actor: OPERATOR,
      action: created ? 'user.created' : 'membership.added',
      entity: { type: 'user', id: memberId },
      before: null,
      after: { email, role: params.role },
    });
  });
  return { userId: memberId, created };
}
