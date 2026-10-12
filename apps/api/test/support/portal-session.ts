import { tenantMemberships, users, type Database } from '@sifen/db';
import { sql } from 'drizzle-orm';
import {
  generateSessionToken,
  hashSessionToken,
} from '../../src/modules/identity/domain/session-token.js';
import { COOKIE_NAMES } from '../../src/modules/identity/infrastructure/http/auth-cookies.js';

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAA';

/**
 * A new user with an MFA-verified portal session; with a tenant it is a member of it (with that role) and the
 * tenant is the session's active one. Returns the `cookie` request header.
 */
export async function portalSessionCookie(
  db: Database,
  email: string,
  tenant?: { tenantId: string; role: 'owner' | 'admin' | 'emisor' | 'lector' },
): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash: HASH, displayName: email })
    .returning();
  if (tenant) await db.insert(tenantMemberships).values({ ...tenant, userId: user.id });
  const token = generateSessionToken();
  const future = new Date(Date.now() + 3_600_000).toISOString();
  await db.execute(sql`insert into user_sessions
    (user_id, family_id, access_hash, refresh_hash, access_expires_at, refresh_expires_at, absolute_expires_at, mfa_verified_at, active_tenant_id)
    values (${user.id}, gen_random_uuid(), ${hashSessionToken(token)}, ${hashSessionToken(generateSessionToken())},
      ${future}, ${future}, ${future}, now(), ${tenant?.tenantId ?? null})`);
  return `${COOKIE_NAMES.access}=${token}`;
}
