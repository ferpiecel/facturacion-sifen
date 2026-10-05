# HU-E6-04: recuperación de un envío sin respuesta

- Feature: `hu-e6-04-recovery` · Refs: HU-E6-04
- Engram mirror: `odd/hu-e6-04-recovery/tasks`
- TDD: strict (source: project/session config) · runner: Vitest (`pnpm exec vitest run --coverage`, thresholds 85%)
- Delivery: `ask-on-risk`, chain `stacked-to-main`; chained PRs (each about 400 authored lines or less, advisory).

## Objective

Never leave a lote or a document stranded when SIFEN's answer is lost or late, and never resend while the
outcome is unknown (plan 8.1, ADR-0007, Guía 2024). Acceptance (backlog): timeout means no resend and a query
by a CDC of the lote; 0364 or 48 h means a query by CDC (0420 / 0422).

## Problem (gap analysis)

- `SendLote` records `unknown` (no answer / unexpected code) and stops: nothing ever queries it; a lote that
  crashed in `sending` is never recovered either.
- `PollLoteResult` moves a lote to `recovery` on 0364, 0360 or a lapsed 48 h window, and to `processed` with
  `needsRecovery` CDCs when 0362 leaves some DE unsettled; no consumer exists for either, and `recovery` is a
  terminal state in the DB guard. Documents stay `submitted` forever.
- `consultarDE` exists in the gateway port, SOAP adapter and simulator but no use case calls it.

## Normative basis

- Guía 2024: lote queries are valid 48 h after sending (0364); afterwards query each CDC with the consulta DE
  service. Response 0420 = the DE does not exist or is not approved (resend, taking the lote result into
  account first); 0422 = exists and is approved (returns the DE XML).
- Plan 8.1 steps 2 and 3. Technical notes prevail over the Manual (ADR-0012); none changes this flow.

## Scope

In: recovery by CDC for `recovery` lotes (slice 1), cycle and worker wiring (slice 2), no-response sends
(`unknown` and stale `sending` lotes) and the 0420 outcome (slice 3).
Out: synchronous emission (HU-E6-05), the 72 h deadline watch, portal UI.

## Constraints

- A query is read-only; a failed or ambiguous query is retried later and never triggers a resend.
- A document is only settled from a definitive answer: 0422 approves; 0420 alone never rejects or requeues.
- FORCE RLS, `withTenantTransaction`, compare-and-set writes, error class only in logs/messages.
- No SIFEN call inside a DB transaction.

## Technical decisions

| Decision | Rationale |
|---|---|
| `RecoverLoteByCdc` use case, `LoteRecoveryStore` port, query all still-`submitted` CDCs of the lote | Mirrors `PollLoteResult`; per-CDC queries are what the Guía prescribes after 48 h |
| Pace recovery by `lotes.last_polled_at` (>= 10 min), no new column | The poll already stamps it when handing over; Guía keeps the 10 min minimum between queries |
| 0422 settles the document as `approved` with message `0422`; the XML does not carry `dEstRes`, so an approval with observations cannot be told apart | Only information the answer actually holds; no invented status |
| 0420 or a failed query leaves the CDC unresolved and the lote in `recovery` (re-queried later) | Guía: 0420 may mean "not yet processed"; resending is slice 3 and needs the 48 h-since-send proof |
| Lote becomes `processed` only when no CDC is left unresolved; migration 0031 allows `recovery -> processed` | Guard currently makes `recovery` terminal |
| 0422 whose XML does not contain the CDC is treated as unresolved | Defends against a mismatched answer |

## Tasks

- [x] T1 Migration 0031: lotes guard allows `recovery -> processed` (+ down script, snapshot, journal) and its DB test.
- [x] T2 `RecoverLoteByCdc` use case (unit tests with `FakeSifenGateway`).
- [x] T3 `createDrizzleLoteRecoveryStore` (load, record with CAS, settle via shared `settleDocument`; PGlite tests under RLS).
- [x] T4 `TransmissionCycle` + store: `recoverableLoteIds`, `recoverer` dep, report field; worker wiring.
- [ ] T5 Unknown and stale `sending` lotes: stale-sending sweep to `unknown`; recover by a CDC of the lote; 0420 policy.
- [ ] T6 Docs: roadmap checkbox, plan notes, PR descriptions.

## PR slices (chained, each about 400 changed lines or less; the generated snapshot is declared in PR 1)

| PR | Branch | Tasks | Content |
|---|---|---|---|
| 1 | `feat/hu-e6-04-recovery-migration` | T1 | Feature doc, migration 0031 (+ down, snapshot, journal), lotes DB test |
| 2 | `feat/hu-e6-04-recovery-use-case` | T2 | `RecoverLoteByCdc`, its port and spec |
| 3 | `feat/hu-e6-04-recovery-settle-refactor` | T3 | Extract `settleDocument` from the poll store (no behavior change) |
| 4 | `feat/hu-e6-04-recovery-store` | T3 | Drizzle recovery store and its spec |
| 5 | `feat/hu-e6-04-recovery-cycle` | T4 | Cycle recover step, `recoverableLoteIds`, factory wiring, end-to-end spec |
| 6 | `feat/hu-e6-04-recovery-no-response` | T5, T6 | Planned: unknown and stale `sending` lotes, 0420 policy, docs |

## Acceptance criteria

- A `recovery` lote whose CDCs answer 0422 ends `processed` with every document `approved` and one outbox
  `document.approved` event each; no resend happens.
- A CDC answering 0420, a transport error or an unexpected code stays `submitted` and the lote `recovery`.
- Queries are not repeated before 10 min; concurrent runs do not double-settle.

## Checks

`tsc --noEmit`, `lint`, `vitest run --coverage` in apps/api, packages/db, packages/sifen-gateway when touched;
`depcruise src --config .dependency-cruiser.cjs` in apps/api.

## Progress

Route: one writer, inline per task. Strict TDD: each PR has a RED commit (failing tests only) then GREEN.

PRs 1 to 5 implemented and verified locally (tsc, lint, depcruise, vitest --coverage at each branch tip). PR 6 (T5, T6) pending.
