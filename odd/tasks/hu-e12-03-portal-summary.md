# HU-E12-03: resumen del período (API del portal)

- Feature: `hu-e12-03-portal-summary` · Refs: HU-E12-03 · Engram mirror: `odd/hu-e12-03-portal-summary/tasks`
- TDD: strict (project config) · runner: Vitest (`pnpm --filter @sifen/api test`) · Delivery: `ask-on-risk`, chained drafts if over 400 lines.
- Route: one delegated writer (this one), inline.

## Objective

`GET /portal/summary?from&to`: count and PYG amount by type and status, rejections with top SIFEN codes, pending
documents against the 72 h clock, and the previous same-length window count. Session + active tenant, current environment only.

## Decisions

- 72 h: no constant exists in the code (the `DeadlineWatchWorker` of HU-E6-07 is not built). Definition from ADR-0008 and
  plan §8: deadline = `signed_at + 72 h`. Pending = `signed|queued|submitted`. `overdue` = deadline < now; `dueSoon` = not overdue and deadline <= now + 12 h.
- Pending is the current state of the tenant (not restricted to the period): an overdue document matters whatever its issue date.
- Amounts are stored positive (also NCE); reported as stored. Only PYG documents add to `amountPyg`; others count in `otherCurrencyCount`.
- Period = Asuncion calendar days on `issued_at`, applied as a sargable timestamp range.

## Tasks

- [ ] T1 Domain: period resolution and validation (default 30 days, max 366, previous window) + unit tests.
- [ ] T2 Use case + port: assemble contract, 72 h buckets with injected clock + unit tests.
- [ ] T3 SQL adapter + controller + module wiring + e2e (isolation, buckets, dates, 401/403).
- [ ] T4 `pnpm verify`, PR(s).

## Debt

- No `(tenant_id, issued_at)` index on `documents` (shared with the list); aggregates scan the tenant's rows. Add one when volume requires it.
