# HU-E6-06 synchronous transmission (siRecepDE) behind a tenant flag

- Feature: `hu-e6-06-sync` · Refs: HU-E6-06 (F2, ADR-0007, plan 8.x sync) · Engram mirror: `odd/hu-e6-06-sync/tasks`
- TDD: strict (`openspec/config.yaml`), runner Vitest (`pnpm --filter <pkg> exec vitest run`)
- Delivery: `ask-on-risk`, chain `stacked-to-main`, PRs of 400 lines or less. Forecast ~900 lines, 3 PRs (A1 application, A2 persistence + wiring, B wait).
- Route: inline (focused reads, 1 to 3 files per decision); no delegation triggers fired beyond the initial mapping, done inline.

## Objective

Opt-in synchronous send of a single DE through `siRecepDE`; SIFEN code 1264 (RUC not enabled) disables the flag and falls back to the batch path; `?wait=true` holds the POST response up to a configurable bound (max 30 s). Batch stays the main path (ADR-0007).

## Design

- Flag: `tenant_fiscal_profiles.sync_transmission boolean NOT NULL DEFAULT false` (table already has RLS). Migration 0064 only.
- `SendLote`: for a lote of exactly 1 document and a tenant with the flag, claim, call `enviarDESincronico`. Definitive `dEstRes` (Aprobado / Aprobado con observacion / Rechazado) settles the lote (`processed`) and the document in one transaction (queued -> submitted -> outcome, outbox events). Code 1264: nothing was processed, the flag is cleared (audit `tenant.sync_transmission_disabled`, actor transmission worker), the claim is released and the same lote is sent through `enviarLote` immediately. Any other answer or a failure after the call started: lote `unknown`, recovered by CDC, never resent. Circuit open: deferred as today.
- Lotes of 2+ documents always go by batch. The 72 h deadline queue and idempotency are untouched (same lote, same document states).
- `?wait=true`: only for a tenant with the flag; polls the document status every 500 ms until final or `SYNC_WAIT_TIMEOUT_MS` (default 30000, 1000 to 30000, fail-fast), then 200 with the final state, else the usual 202. The worker still runs on `TRANSMISSION_CYCLE_INTERVAL_MS`; documented.

## Tasks

- [x] A1 (PR #372, branch feat/hu-e6-06-sync, pushed, verify green): `SendLote` sync path behind an optional `SyncDispatch` port, `RUC_NO_HABILITADO_SINCRONICO` code (inert until A2 wires it)
- [x] A2: migration 0064 + schema flag + `createDrizzleSyncDispatch` + worker wiring + cycle integration tests + fix: a failing flag clear on 1264 still falls back to batch (verify via push)
- [x] B (PR #378, chained on #376): `?wait=true`, `SYNC_WAIT_TIMEOUT_MS`, docs, OpenAPI regen (verify via push)
- [x] C (PR #380, pushed, verify green): ops CLI `tenant:sync-transmission --tenant <id> --on|--off` + docs/operacion.md (separate PR to stay under 400 lines; written and green locally, committed on branch feat/hu-e6-06-sync-cli)

## Progress and evidence

- Restack (post #370 merge): chain rebased onto main (migration 0064 after 0063, snapshot prevId chained). Review fixes, each RED first where it failed: #376 test pinning recovery by CDC when `recordSettled` fails (already behaved correctly: lote goes `unknown`, no second submission); #378 `?wait=true` answers 202 if the hold throws (was 500); #380 `--actor <name>` required on `tenant:sync-transmission` (audit actor, was fixed `ops-cli`).

## Handoff

Chain: #376 (A2, migration 0064) <- #378 (B, wait) <- #380 (C, ops CLI), rebased on main, ready for review. Remaining: review, merge in order.
