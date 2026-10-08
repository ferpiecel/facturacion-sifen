# HU-E1-06 — Partner operational status without documents

- Refs: HU-E1-06, ADR-0014 · Engram mirror: `odd/hu-e1-06-partner-status/tasks` · TDD strict, Vitest · chained PRs <= 400 lines
- Objective: a partner user sees per owned tenant only name, environment, certificate status/expiry and document counts by status.

## Decisions

- D1 Partner auth = verified portal session (`SessionGuard`) + `partner_memberships`. Partner API keys (ADR-0014): debt.
- D2 RLS: role `partner_viewer` + `app.current_partner`; column grants hide document content and certificate secrets.
- D3 Membership via SECURITY DEFINER `user_in_partner` (session_resolver, pattern of 0039).
- D4 Portal-session endpoint: not in `docs/api/openapi.json` (integrator API only).

## Tasks

- [ ] T1 (PR 1, db) migration 0044, `withPartnerTransaction`, isolation tests (partner vs foreign tenant)
- [ ] T2 (PR 2, api) `GET /partners/:partnerId/tenants/status`
- [ ] T3 `pnpm check` + db Postgres suite
