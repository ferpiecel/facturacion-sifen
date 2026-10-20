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

- [ ] E6-08 A: `CircuitBreaker` state machine (closed, open, half-open; doubling cool-down capped below 72 h) in `packages/sifen-gateway` (this PR)
- [ ] E6-08 B: `CircuitBreakerGateway` decorator, one breaker per endpoint, `SifenCircuitOpenError`, `pausedUntil`
- [ ] E6-08 C: `SendLote` defers on an open circuit before claiming, the cycle stops sending, worker wiring and docs
- [ ] E6-05: pause a blocked tenant by RUC and requeue with delay; metric and alert
- [ ] E6-09: `siConsRUC` lookup with cache and TTL; validate receivers
- [ ] E6-06: sync transmission behind the tenant flag; 1264 falls back to the lote; `?wait=true` up to 30 s

## Route declaration

Inline for every task: each slice is one focused module with its tests, read through direct file reads (1 to 3 files per decision).

## Progress and evidence

(updated per task)
