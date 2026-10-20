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

- [x] T1 migration 0050: plans, plan_prices (EXCLUDE), plan_price_tiers, subscriptions, payments (PR #284, merged as 88a5aa7)
- [x] T2 migration 0051: invoices_saas and usage_counters with an increment-only trigger (PR #296: ea98231, 06223f0, 0bcf643)
- [x] T3 count accepted documents in the acceptance transaction (PR 2/2 of the usage stream: 2e40aab rebuilt on main)
- [x] T4 migration 0054 (0052/0053 taken by transmission, 0055 by the email outbox; PR #302): plans.audience and subscription price snapshot (monthly_price, overage_price, document_quota); no tiers, no plans.overage_price
- [ ] T5 ops `plan:*` and `plan:seed` reading and writing plan_prices (new row + close previous valid_to, never UPDATE of amounts); document btree_gist CREATE privilege in docs/operacion.md
- [ ] T6 ops `subscription:assign`, `payment:record`, `usage:show` reading plan_prices
- [ ] Follow-up: consider revoking UPDATE on plan_prices price columns from platform_admin; portal/API `GET /v1/usage`; SaaS invoice issuing (v1.0)
