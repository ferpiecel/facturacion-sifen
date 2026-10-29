# Ops CLI gaps before the pilot (E14)

- Feature: `hu-e14-ops-gaps` · Card: E14 "Operación y paso a producción"
- Engram mirror: `odd/hu-e14-ops-gaps/tasks`
- TDD: strict (source: openspec/config.yaml) · runner: Vitest (`pnpm --filter @sifen/api exec vitest run src/cli`)
- Delivery: `auto-chain`, 3 PRs (~400 lines each max)

## Objective

Add the missing operator commands to `apps/api/src/cli`: audit query/verify, RUC pause lift, documents
near the 72 h deadline, certificates about to expire. Cross-tenant reads go through `asPlatformAdmin`.

## Tasks

- [x] T1 `audit:list` (tenant, action, date range, paged by seq) and `audit:verify` (PR 1, #397, 969ab989)
- [x] T2 `document:deadline` (tenant or all tenants, hours remaining) (PR 2, #399)
- [x] T3 `certificate:expiring` (days default from `CERTIFICATE_ALERT_DAYS`) (PR 3)
- [ ] T4 `ruc:unblock`: needs migration (ruc_blocks has no UPDATE grant): `lifted_at`/`lifted_by` columns,
      guard + gauge ignore lifted blocks, audited (PR 4)
- [ ] T5 Docs: `docs/operacion.md` and runbooks (`ruc-bloqueado`, `de-plazo-72h`, `certificado-vencido`) with each PR

## Decisions

- Audit output never prints `before`/`after`; ids, seq, timestamps, actor, action, entity only.
- Dates use the Paraguay calendar (-03:00) like `usage:show`.
