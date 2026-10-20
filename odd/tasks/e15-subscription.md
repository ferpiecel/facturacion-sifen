# E15 — Subscription model and usage counters

- Refs: HU-E15-01, HU-E15-02, RF-17 · Engram mirror: `odd/e15-subscription/tasks` (pending) · TDD strict, Vitest · chained PRs <= 400 lines
- Objective: MVP data model for plans, subscriptions, payments and SaaS invoices, plus an atomic per-tenant per-period usage counter. No gateway charging (v1.0, PRD F7).

## Decisions (technical)

- D1 Plans are platform-level data (no `tenant_id`): `app_user` reads, only `platform_admin` writes. Values (price, limits) are rows seeded through the ops CLI, never constants in code.
- D1b Prices are effective-dated: `plan_prices` (plan_id, monthly_price, included_documents, overage_price, valid_from, valid_to) with an EXCLUDE constraint (btree_gist) against overlapping validity per plan; partner volume tiers in `plan_price_tiers`. `plans` holds no price. Landed in PR 1 (migration 0050) after review of #284; the later pricing slices must build on it.
- D2 Subscriptions, payments, invoices_saas and usage_counters are tenant-scoped under RLS. A tenant reads its own rows; only `platform_admin` (ops) writes plan data, subscriptions, payments, invoices.
- D3 Payments are recorded manually by ops (`method = 'manual'`); `payment_methods`/gateway tokens wait for Bancard/Pagopar (v1.0).
- D4 Usage counter: one row per (tenant, month), incremented with `INSERT ... ON CONFLICT DO UPDATE` (single atomic statement). A trigger forbids decrements.
- D5 Enforcement of limits at acceptance is NOT in the MVP (PRD F7 "aviso al 80 % y política al 100 %" is v1.0): count and expose the 80 % warning only.

## Open product questions

- P3: plan prices (PRD marks them as pending). Limits per tier exist in plan v1.0 §11.1 (30/300/3000/15000 docs per month) but are not confirmed for the MVP. Both are configurable data.
- Policy at 100 % (block, overage, auto-upgrade): not decided; v1.0.
- Billing period boundary: calendar month in UTC (assumption) vs America/Asuncion.

## Tasks

- [x] T1 (PR 1, db) migration 0050: plans, subscriptions, payments, RLS, tests
- [x] T1b (PR 2, db) migration 0051: invoices_saas and usage_counters (increment-only trigger), tests
- [ ] T2 (PR 2, api) hexagonal `billing` module: domain, ports, Drizzle adapter, use cases (assign plan, record payment, record usage, get usage with 80 % warning)
- [ ] T3 (PR 3, api) ops CLI `plan:create`, `plan:assign`, `payment:record`; usage hook on document acceptance
