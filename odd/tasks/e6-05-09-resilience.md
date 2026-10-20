# E6 transmission resilience: circuit breaker, tenant pause, RUC lookup, sync transmission

- Feature: `e6-05-09-resilience` · Refs: HU-E6-08, HU-E6-05, HU-E6-09, HU-E6-06 (F2; RNF-03, RNF-07, ADR-0007, ADR-0008)
- Engram mirror: `odd/e6-05-09-resilience/tasks`
- TDD: strict (source: `openspec/config.yaml`, `strict_tdd: true`) · runner: Vitest (`pnpm --filter <pkg> exec vitest run`, thresholds 85%)
- Delivery: `ask-on-risk`, chain `stacked-to-main`; each PR 400 changed lines or less (hard limit of CLAUDE.md).
- Order (PO): E6-08, E6-05, E6-09, E6-06. Most sensitive area: never risk a double send.

## Objective

Keep DEs safe while SIFEN is unreachable or a tenant is blocked, validate receivers by RUC with a cache, and offer opt-in sync transmission.

## Constraints

- Never resend a lote SIFEN may hold: a transport error or timeout after the call started stays `unknown` and is recovered by CDC.
- A circuit-open refusal is the only "provably not sent" failure: the lote returns to `pending`.
- Lote ordering debt (#264, `lotes.seq`): do not add timestamp comparisons to `stillCarries` / `recoverableInLote`.
- Worker process is shared with the E8 event worker (another stream): coordinate through main, touch only the transmission wiring.

## Tasks

- [x] E6-08 A (#282, merged; probe timeout, stale-call token and cap fixes in #286): `CircuitBreaker` state machine (closed, open, half-open; doubling cool-down capped below 72 h, exclusive: `maxOpenMs` of 72 h or more is rejected) in `packages/sifen-gateway` (this PR)
- [x] E6-08 B (#286): `CircuitBreakerGateway` decorator, one breaker per endpoint, `SifenCircuitOpenError`, `pausedUntil`
- [x] E6-08 C (#287): `SendLote` defers on an open circuit before claiming, the cycle stops sending, worker wiring and docs
- [x] E6-05 A (#290, 1196132): `ruc_blocks` table (append-only, RLS), migration 0050
- [x] E6-05 B (#291, 9e28d72): a 0301 that says the RUC is blocked records the pause and requeues the documents without counting an attempt
- [x] E6-05 C (0bb77ca, no PR yet): the cycle sends nothing while the pause lasts (fail closed); error alert and `sifen_ruc_block_total` log metric
- [ ] E6-09: `siConsRUC` lookup with cache and TTL; validate receivers
- [ ] E6-06: sync transmission behind the tenant flag; 1264 falls back to the lote; `?wait=true` up to 30 s

## Route declaration

Inline for every task: each slice is one focused module with its tests, read through direct file reads (1 to 3 files per decision).

## Progress and evidence

- RED observed per slice (breaker module missing; `pausedUntil` 7 failures; `SendLote`/cycle 3 failures; ruc-block 9 failures; pause 8 failures).
- `pnpm verify` runs through the pre-push hook; a first run died of SIGKILL (memory shared with other streams) and was repeated.
