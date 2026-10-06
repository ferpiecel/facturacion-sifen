# HU-E1-07 — Portal login with MFA and roles

- Feature: `hu-e1-07-portal-login` · Refs: HU-E1-07, RF-13, ADR-0005, ADR-0014 · Engram mirror: `odd/hu-e1-07-portal-login/tasks`
- TDD: strict (project config) · runner: Vitest (`pnpm --filter @sifen/db test`, `@sifen/api test`, `@sifen/web test`)
- Delivery: `ask-on-risk`, chain `stacked-to-main`; every slice <= 400 authored changed lines (generated snapshots excluded).

## Objective

A portal user signs in with email + password + TOTP, holds one of the roles `owner`, `admin`, `emisor`, `lector` per
tenant, and, when a member of several tenants, chooses the active tenant (backlog HU-E1-07; PRD A4, RF-13).
Unblocks HU-E12-01/02 (portal list and detail) and is the `user` actor of the audit log.

## Gap analysis (explored on main @ 0036)

- No `users`, `sessions` or `tenant_memberships` table. Portal in `apps/web` is mock-only; no BFF routes, no auth.
- Plan v1.1 (line 195) lists "Better Auth o Keycloak" without choosing. No ADR covers human auth or sessions.
- Reusable: Argon2id port/adapter and pinned `ARGON2_PARAMS` (`apps/api/src/modules/identity`), `EnvelopeCipher`
  custody (TOTP secret), `withTenantTransaction`, `recordAudit` (`actor_type = 'user'` exists; `audit_log.tenant_id`
  is NOT NULL, so pre-tenant events need another home), SECURITY DEFINER resolver-role pattern (migration 0003).
- `users` is a global identity (a user may belong to several tenants), so it cannot carry `tenant_id` or the
  `tenant_isolation` policy; `tenant_memberships` is the tenant-scoped join and does.
- PRD settles: roles (A4), user in N tenants (line 54), invitation of users (step 9, line 81; MVP is operator-provisioned,
  line 83), SSO is v1.1 (RF-24), login with MFA is MVP (roadmap line 89), the partner sees only operational metadata (ADR-0014).

## Constraints (security)

1. Passwords: Argon2id with the pinned `ARGON2_PARAMS`; verify against a dummy hash on unknown email (same cost, no enumeration).
2. TOTP secret sealed with the existing envelope encryption (AAD binds user id); never stored or logged in clear.
3. Rate limiting per account and per IP, plus lockout with back-off; same generic error for unknown user, bad password and locked.
4. Session fixation: a fresh session id on login and again after MFA; opaque id, only its SHA-256 stored.
5. BFF cookie: `__Host-` prefix, HttpOnly, Secure, SameSite=Lax; CSRF defence on mutating BFF routes (Origin check + token).
6. TOTP replay: a time step is accepted once (`last_used_step`); constant-time compare; recovery codes stored hashed.
7. Audit login success/failure, MFA enrol/verify/reset, tenant switch, role change (actor `user`).
8. FORCE RLS on every new table; `app_user` gets only the grants it needs.

## Technical decisions (mine)

- D1 Own implementation in the hexagonal `identity` module, not Better Auth or Keycloak. Better Auth owns its schema
  (conflicts with FORCE RLS, envelope-sealed TOTP and the hash-chained audit); Keycloak is one more service to run for an MVP
  with no SSO. SSO (v1.1, RF-24) arrives as an OIDC adapter behind the same port. To be recorded as an ADR in slice 5.
- D2 Server-side opaque sessions, no JWT: revocable, lockout and role changes apply immediately.
- D3 `users` has no grant to `app_user`; pre-auth lookups go through a SECURITY DEFINER resolver role (pattern of 0003) in a later slice.
- D4 Pre-tenant auth events (failed login, MFA before a tenant is chosen) go to a non-tenant `auth_events` table; once a
  tenant is active, events go to `audit_log`. Decided in slice 4.
- D5 TOTP with `node:crypto` HMAC-SHA1 (RFC 6238), no new dependency.
- D6 Email stored lower-case (CHECK), unique.

## Product questions (answers needed; defaults proposed)

See the final report; defaults apply until answered. Settled by docs: invitation-only provisioning (PRD step 9, line 83),
no SSO in MVP (RF-24), roles list (PRD A4).

## Slices

- [x] S1 `feat/hu-e1-07-portal-login` — migration 0037: `users`, `tenant_memberships` + `portal_role` enum, FORCE RLS,
      down script, snapshot, journal. Independent of the product questions.
  - Acceptance: users unique by lower-case email, no `app_user` grant; memberships unique per (tenant, user), role enum of 4,
    `tenant_isolation` policy for `app_user`, identity columns immutable; RLS drift check covers it.
  - Checks: `@sifen/db` tsc, lint, `vitest run --coverage`.
- [ ] S2 Password domain and use cases in `apps/api/.../identity`: `PasswordHasher` port reusing `ARGON2_PARAMS`, password
      policy, `verifyPassword` with dummy hash, create user (operator-provisioned).
- [ ] S3 TOTP: domain (RFC 6238, replay guard), sealed secret column + migration 0038, enrol/verify use cases, recovery codes.
- [ ] S4 Sessions + login/MFA use cases + lockout/rate limit + audit events; resolver role migration 0039.
- [ ] S5 API/BFF endpoints (`/auth/*`), cookie, CSRF, active-tenant selection and switch; ADR for D1-D4.
- [ ] S6 Portal UI in `apps/web`: login, MFA, tenant picker, role-aware guard.

## Progress

- Route: explore delegated none (map done inline over 8 reads); writer inline (single writer, one DB slice).
- S1 done: RED b1f5929 (9 failing), GREEN with migration 0037; @sifen/db tsc, lint, coverage and postgres-driver tests green; api tsc + depcruise green. Next: S2 (password domain), independent of the TOTP and session questions.
