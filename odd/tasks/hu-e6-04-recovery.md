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
- [x] T5 Unknown and stale `sending` lotes: stale-sending sweep to `unknown`; recover by a CDC of the lote; 0420 policy.
- [x] T5a (fold into T5) `processed` lotes with `needsRecovery` documents are never picked up again: make them recoverable by CDC too.
- [x] T5b Preserve the original hand-over reason (0364, 0360, window elapsed) instead of overwriting `last_poll_message` on each recovery pass.
- [ ] T7 (debt) Cap the CDC queries per run and per lote, and check the abort signal between sequential queries, so a large lote cannot hold the tenant lock or outlive its lease.
- [x] T8 (done in PR 8, `recovery-hold`) Escalate a CDC that answers 0420 forever: hold or alert the document after a bound (age since send or attempts) instead of re-querying every 10 minutes indefinitely.
- [~] T9 Resend after 0420 past the window. Decision (tech lead): C first (hold + alert, done as T8 in PR 8), then B (one audited `submitted -> queued` transition) in a later PR. B is not implemented.
- [x] T10 A send that finishes after the stale sweep is still recorded (`sending` or `unknown` accepted), so its protocol is not lost (PR 9).
- [x] T11 The stale sweep is bounded (`batch.sweep`, default 100, oldest first, strictly before the cutoff) (PR 9).
- [ ] T6 Docs: roadmap checkbox, plan notes, PR descriptions.

## PR slices (chained, each about 400 changed lines or less; the generated snapshot is declared in PR 1)

| PR | Branch | Tasks | Content |
|---|---|---|---|
| 1 | `feat/hu-e6-04-recovery-migration` | T1 | Feature doc, migration 0031 (+ down, snapshot, journal), lotes DB test |
| 2 | `feat/hu-e6-04-recovery-use-case` | T2 | `RecoverLoteByCdc`, its port and spec |
| 3 | `feat/hu-e6-04-recovery-settle-refactor` | T3 | Extract `settleDocument` from the poll store (no behavior change) |
| 4 | `feat/hu-e6-04-recovery-store` | T3 | Drizzle recovery store and its spec |
| 5 | `feat/hu-e6-04-recovery-cycle` | T4 | Cycle recover step, `recoverableLoteIds`, factory wiring, end-to-end spec |
| 6 | `feat/hu-e6-04-recovery-no-response` | T5, T5a, T5b | Migration 0032 (`unknown -> processed`); recover `unknown` and `processed`-with-leftovers lotes by CDC; keep the hand-over reason |
| 7 | `feat/hu-e6-04-recovery-stale-sending` | T5 | Sweep lotes stuck in `sending` to `unknown`; cycle recovers `unknown` and leftover lotes |
| 8 | `feat/hu-e6-04-recovery-hold` | T8 | Hold + warning for a CDC that keeps answering 0420; lote settled when nothing is left to query |
| 9 | `feat/hu-e6-04-recovery-late-record` | T10, T11 | Late send record accepted on `unknown`; bounded sweep; mixed 0422/0420 and rollback tests |
| 10 | Pending | T6, T7, T9-B | Docs, per-run cap of CDC queries, audited resend |

## Decisions of PRs 6 and 7

| Decision | Rationale |
|---|---|
| Migration 0032 adds only `unknown -> processed` (not `unknown -> recovery`) | `recovery` means the result query by protocol lapsed; an unknown lote has no protocol. A partial answer keeps the lote `unknown` and the resolved documents leave its pending list |
| An `unknown` lote's documents are `queued`; on 0422 they go `queued -> submitted` (event `document.submitted`) and then `approved` in one transaction | The 0422 is the proof that SIFEN received the lote; the documents guard only allows approval from `submitted` |
| Store CAS also guards on the loaded lote status (`expectedStatus`) | One use case and one store serve `recovery`, `unknown` and `processed` without races between them |
| `processed` lotes are recoverable only while they still hold `submitted` documents; they stay `processed` | Needs no migration (no status change); fixes documents the poll left unsettled (`needsRecovery`) |
| Hand-over reason kept: `last_poll_message` = reason + ` \| recovery: N document(s) still unresolved...`, rewritten (not appended) on each pass, and reduced to the reason when settled | No new column; the original 0364/0360/window reason survives |
| `sending` older than 30 min (`staleSendingAfterMs`) becomes `unknown` at the start of the send step | A crash between claim and record leaves SIFEN possibly holding the lote; `sending -> unknown` was already allowed by the guard. A very slow send that finishes later fails its own record (`not in sending state`) instead of being resent |

## Decisions of PRs 8 and 9

| Decision | Rationale |
|---|---|
| Hold `recovery:0420-unresolved` at the third 0420 answer and never before 48 h after the send (`sent_at`, else the lote `created_at`) | One 0420 may only mean "not processed yet"; Guía 2024 says a lote is processed within 24 h and is queryable for 48 h. Three answers 10 minutes apart after the window is SIFEN saying it does not hold the DE |
| The count is the document's `transmission_attempts`; only a 0420 counts (not timeouts or odd codes) | Reuses the existing column and `document:release-hold`, which resets it (and audits the release): a released document gets three more passes before it is held again. Documents mixing 0301 attempts only reach the hold sooner when they are also past 48 h |
| The alert is a `warn` log per held document (plus the existing held-documents report in the worker) | There is no notification channel yet |
| Held documents are not loaded for recovery and `recoverableLoteIds` ignores processed lotes whose submitted documents are all held | The lote stops being re-queried |
| A lote whose remaining documents are all settled or held becomes `processed` (guard already allows it from `recovery` and `unknown`; no migration) | It leaves the recoverable states |
| A released `queued` document of an unknown lote is picked up by the assembler again (that is the operator resubmit of option C); a released `submitted` document is queried again until B exists | Option C as decided |
| `SendLote` record accepts `unknown` as well as `sending`; the guard already allows `unknown -> sent/rejected` | A slow send finishing after the sweep keeps its protocol; a lote already closed by recovery still refuses the record |
| `sweepStaleSending(cutoff, limit)`, oldest first, strict `<` cutoff | Bounded work per cycle; a lote updated exactly at the cutoff is not stale |

## T9 design note: resending after 0420 past the window (decision pending)

Guía 2024 allows resending a DE answered 0420 ("does not exist or not approved"), taking the lote result into account first. We must keep the same CDC (correction does not alter its fields) and the same document. The `documents` guard forbids `submitted -> queued` (rank must increase), and `cdc` is unique and immutable, so a second document row for the same CDC is impossible.

| Option | What it is | Pros | Cons |
|---|---|---|---|
| A. New lote attempt without changing the document guard | Let the assembler pick `submitted` documents whose every lote is closed as abandoned (new lote status or flag); `SendLote` already tolerates `submitted` | No change to the documents guard; same CDC | `submitted` stops meaning "SIFEN holds it"; assembler and LoteBuilder rules get a special case; harder to reason about in-process CDCs |
| B. Relax the guard under audit | Allow the single transition `submitted -> queued` through a dedicated path: lote terminal (`recovery`/`unknown`), at least 48 h since the send, last answer 0420, `transmission_attempts` incremented, one `audit_log` row (hash chain) | Explicit, auditable, reuses the existing queue, backoff and attempt cap | Migration touching the documents guard; must be tightly scoped so nothing else can regress a status |
| C. Hold and escalate, no automatic resend | After the window a 0420 CDC gets `transmission_hold` (`recovery:0420-after-window`) and an alert; an operator resubmits | No guard change; safest | Manual work for a case that is rare but real; needs an operator action and UI |

Recommendation: C now (it is T8, small and safe, and it stops the endless 10-minute queries), then B for the actual resend, as a single audited transition with the preconditions above. A is not recommended. Needs your decision before T9.

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

Review fixes applied after PRs #156 to #160 (log counts, DE Id match, recovery transitions); the findings above are recorded as debt, not implemented.

PRs 1 to 9 implemented and verified locally (tsc, lint, depcruise, vitest --coverage at each branch tip). Pending: T6, T7, T9-B.
