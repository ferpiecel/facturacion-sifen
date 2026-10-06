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
- D7 Password policy per NIST SP 800-63B: min 12 / max 128 code points (NFKC, no truncation), no composition rules,
  embedded blocklist (common passwords, sequences, repeats) plus service words and the account's email local part. A
  breached-password corpus (k-anonymity) is a later port. Unknown and malformed emails cost one Argon2 verification (dummy hash).
- D8 Operator-created users get the audit row in a tenant (`audit_log.tenant_id` NOT NULL): `user:create` takes `--tenant`
  and `--role`; an existing email is reused (its password is untouched), so an accountant joins a second tenant.
- D9 TOTP secret AAD: kind `mfa`, tenant slot `platform`, label = user id (a user belongs to no single tenant).
- D10 Recovery codes: 16 base32 chars (80 bits), SHA-256 (fast hash is fine for 80 random bits; passwords use Argon2id).
- D6 Email stored lower-case (CHECK), unique.

## Product questions (answers needed; defaults proposed)

PROVISIONAL defaults, applied until the product owner answers (none is built yet; all affect S3 onwards):

1. MFA mandatory for every role, enrolled at first login.
2. Session: 8 h absolute, 30 min idle, no re-MFA while it lives.
3. 10 one-time recovery codes at enrolment; owner/admin reset another user's MFA, the operator resets an owner's; audited, ends sessions.
4. Role matrix: in the MVP all roles read documents and download XML/KuDE; only owner/admin manage users and roles, only owner manages owners.
5. Partners do not log in to this portal in HU-E1-07 (separate principal in HU-E1-06, metadata only, ADR-0014).
6. Forgotten password: email link, revokes sessions, MFA still required.
7. Active tenant: remember the last one; switching needs no re-MFA.

Not asked (settled by docs): invitation-only provisioning (PRD step 9, line 83),
no SSO in MVP (RF-24), roles list (PRD A4).

## Slices

- [x] S1 `feat/hu-e1-07-portal-login` — migration 0037: `users`, `tenant_memberships` + `portal_role` enum, FORCE RLS,
      down script, snapshot, journal. Independent of the product questions.
  - Acceptance: users unique by lower-case email, no `app_user` grant; memberships unique per (tenant, user), role enum of 4,
    `tenant_isolation` policy for `app_user`, identity columns immutable; RLS drift check covers it.
  - Checks: `@sifen/db` tsc, lint, `vitest run --coverage`.
- [x] S2 `feat/hu-e1-07-password` (stacked on S1) — password domain and use cases in `apps/api/.../identity`: password
      policy, `PasswordHasher` port (Argon2 adapter, pinned `ARGON2_PARAMS`), `VerifyPasswordUseCase` (dummy hash),
      `CreateUserUseCase`. RED 48342f3, GREEN 2224f84 (+ 77eb58e); S2b RED 39d4d85, GREEN 6b56848. Verified: api tsc, lint, depcruise, 1587 tests, coverage 97.6% funcs.
- [x] S2b `feat/hu-e1-07-user-cli` (stacked on S2) — operator CLI `user:create` (`--password -` from stdin), creates or
      reuses the user, adds the membership, audits as `operator` in the tenant. Split out to stay <= 400 lines. Verified: api tsc, lint, depcruise, 1604 tests, coverage 97.6% funcs.
- [x] S3 TOTP MFA, PROVISIONAL (applies product defaults 1 and 3 until the PO answers), three stacked branches:
  - S3a `feat/hu-e1-07-totp` (on S2b): RFC 6238 domain (HMAC-SHA1, 6 digits, 30 s, +/-1 step, constant-time, last-used-step
    replay guard, otpauth URI), 10 SHA-256-hashed recovery codes, `MfaSecretVault` (new secret kind `mfa`; AAD tenant slot
    `platform`, label = user id). RED 3892dc0, GREEN 3aa11fa.
  - S3b `feat/hu-e1-07-mfa-flows`: ports (`MfaStore`, `MfaSecretSealer`, `SessionRevoker`, `MfaAuditLog`) and the
    Enroll/Confirm/Verify/Reset use cases. Reset: owner/admin reset others, only the operator resets an owner, never self;
    removes the enrolment, calls `SessionRevoker` (S4 supplies the real one), audits. RED 6630525, GREEN 63d0931. About 510
    lines (tests are 60%); split at PR time if the 400-line rule is applied strictly (reset into its own PR).
  - S3c `feat/hu-e1-07-mfa-store`: migration 0038 `user_mfa` (sealed secret, step, hashed codes, FORCE RLS, no app_user grant,
    guard trigger, down script) and `DrizzleMfaStore` (conditional UPDATEs). RED 633d731 / a89bdb3, GREEN 97b124d / this tip.
  - Security review fixes: reset is tenant-scoped over ALL target memberships (RED e9ce598, GREEN 360d7d0: audit first, revoke sessions, remove MFA last; events carry `tenantIds`; confirm conditional on the verified secret); `user_mfa` guard holes closed (RED 71bc873, GREEN c689013: NULL step, shrink-only recovery hashes, NULL hash elements).
  - Still PROVISIONAL and not wired: enrol-at-first-login enforcement comes with S4 (login), the wiring of audit to
    `recordAudit` and the CLI/endpoint for reset comes with S4/S5.
- [ ] S4 Sessions + login/MFA use cases + lockout/rate limit + audit events; resolver role migration 0039.
- [ ] S5 API/BFF endpoints (`/auth/*`), cookie, CSRF, active-tenant selection and switch; ADR for D1-D4.
- [ ] S6 Portal UI in `apps/web`: login, MFA, tenant picker, role-aware guard.

## Progress

- Route: explore delegated none (map done inline over 8 reads); writer inline (single writer, one DB slice).
- Review fixes (NFKC password, argv/stdin, atomic user:create) merged forward through all branches.
- S2/S2b done (branches `feat/hu-e1-07-password`, `feat/hu-e1-07-user-cli`, not pushed). Next: S3 once product questions 1 and 3 are answered.
- S1 done: RED b1f5929 (9 failing), GREEN with migration 0037; @sifen/db tsc, lint, coverage and postgres-driver tests green; api tsc + depcruise green. Next: S2 (password domain), independent of the TOTP and session questions.
