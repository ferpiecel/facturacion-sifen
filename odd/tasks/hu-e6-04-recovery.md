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
- [x] T7 (done in PR 10, `recovery-cap-audit`) Cap the CDC queries per run and per lote, and check the abort signal between sequential queries, so a large lote cannot hold the tenant lock or outlive its lease.
- [x] T8 (done in PR 8, `recovery-hold`) Escalate a CDC that answers 0420 forever: hold or alert the document after a bound (age since send or attempts) instead of re-querying every 10 minutes indefinitely.
- [x] T9 Resend after 0420 past the window (option B: done in PRs 12 to 16). Decision (tech lead): C first (hold + alert, done as T8 in PR 8), then B (one audited `submitted -> queued` transition) in a later PR. B is not implemented.
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
| 10 | `feat/hu-e6-04-recovery-cap-audit` | T7 | Per-run cap and abort of CDC queries, safe alert |
| 11 | `feat/hu-e6-04-recovery-hold-audit` | T8 | `system` audit actor (migration 0033) and the hold audit row |
| 12 | `feat/hu-e6-04-audited-resend` | T9-B | Migration 0034: `documents.resent_at` and the one audited `submitted -> queued` door in the guard |
| 13 | `feat/hu-e6-04-resend-check` | T9-B | `ResendPreflight` and the assembler's `resendCheck` (0422 race), `resent` flag in `readyDocuments` |
| 14 | `feat/hu-e6-04-resend-preflight-store` | T9-B | Store that approves a document SIFEN found before it is sent, and the factory wiring |
| 15 | `feat/hu-e6-04-resend-queue` | T9-B | Recovery queues once instead of holding: cap, audit, latest-lote rule, lote settles |
| 16 | `feat/hu-e6-04-resend-e2e` | T9-B | End-to-end proofs (same-CDC resend, 0422 race, unreachable SIFEN) and docs |
| 17 | Pending | T6 | Docs and roadmap |

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
| Hold `recovery:0420-unresolved` at the first 0420 answered at least 48 h after the send (`sent_at`, else the lote `created_at`); a 0420 before that never counts | One 0420 may only mean "not processed yet"; Guía 2024: a lote is processed within 24 h and queryable for 48 h, so past the window a 0420 is definitive. No per-document counter: `transmission_attempts` belongs to the 0301 backoff and must not be shared, and a dedicated column would add a migration for a marginal safety margin |
| Only a 0420 holds (not timeouts or odd codes); `document:release-hold` clears the hold, and a document that still answers 0420 is held again at the next pass | The hold is reversible and the release is audited by the CLI |
| The alert is a `warn` log per held document (plus the existing held-documents report in the worker) | There is no notification channel yet |
| Held documents are not loaded for recovery and `recoverableLoteIds` ignores processed lotes whose submitted documents are all held | The lote stops being re-queried |
| A lote whose remaining documents are all settled or held becomes `processed` (guard already allows it from `recovery` and `unknown`; no migration) | It leaves the recoverable states |
| A released `queued` document of an unknown lote is picked up by the assembler again (that is the operator resubmit of option C); a released `submitted` document is queried again until B exists | Option C as decided |
| A late `sent` clears the `recovery:0420-unresolved` hold of the queued documents it submits (audit row `document.hold_released`, actor `operator` / `transmission-worker`); other holds stay | SIFEN did receive the lote, so the "absent" reason is gone |
| The sweep picks lotes in a locking CTE (`FOR UPDATE SKIP LOCKED`, LIMIT on the locked rows) and its UPDATE re-checks status and cutoff | A lote recording `sent` meanwhile is neither forced to `unknown` nor waited for |
| `SendLote` record accepts `unknown` as well as `sending`; the guard already allows `unknown -> sent/rejected` | A slow send finishing after the sweep keeps its protocol; a lote already closed by recovery still refuses the record |
| `sweepStaleSending(cutoff, limit)`, oldest first, strict `<` cutoff | Bounded work per cycle; a lote updated exactly at the cutoff is not stale |

### Decisions of PR 10 (T7 and alert safety)

| Decision | Rationale |
|---|---|
| `RecoverLoteByCdc` asks at most `maxQueries` CDCs per execution, default 20, overridable through `recoveryMaxQueries` in the cycle factory | Queries are sequential SOAP calls; 20 keeps a pass near a minute at normal latency, and a lote of 50 settles in three 10-minute passes. The cycle already bounds lotes per run (`batch.recover`, 10), so a run asks at most 200 |
| The cycle's run signal reaches the use case; it checks it before each query and returns `aborted` (no write) if already aborted | Same rule as the cycle: the unit in flight finishes, no new one starts when the tenant run lock is lost |
| CDCs not asked (cap or abort) are recorded as `unresolved` with `skipped: true` and never as `absent` | The lote cannot close while they are pending, and silence is not a 0420, so they never count toward a hold |
| `load` orders pending CDCs by `updated_at` and `record` stamps the documents it asked about | Round-robin: a capped pass starts with the CDCs it did not ask last time, so unresolved ones at the front cannot starve the tail |
| A throwing `logger.warn` after the commit is swallowed | The pass is already recorded; the hold stays in the database and in the worker's held-documents report |

### Decisions of PR 11 (hold audit)

| Decision | Rationale |
|---|---|
| Add a proper `system` audit actor type (migration 0033, `ALTER TYPE ... ADD VALUE`, down script recreates the enum) instead of reusing `operator` | An automatic write by the worker is not an operator action, and a trail that says `operator` for it would mislead an audit. The change is one enum value: `audit_log` stores `actor_type::text` in the hash chain, redaction never looks at the actor, and a new spec verifies a chain that mixes a `system` row |
| The hold writes `document.hold_placed` (before `null`, after `recovery:0420-unresolved`) in the same transaction as the hold; the late-send release is now attributed to `system` / `transmission-worker` (shared `TRANSMISSION_WORKER_ACTOR`) | Every hold and release is audited, and a rolled-back record leaves no audit row |
| The down script of 0033 fails while `audit_log` rows use `system` | Rows are append-only: archive them first |

### Decisions of the audited resend (T9-B, option B)

| Decision | Rationale |
|---|---|
| Automatic, once, instead of the hold: the first post-window 0420 of a document never resent before queues it again; a 0420 after a resend (and past the new window) holds it as before | Guía 2024: after 0420 "se debe volver a enviar el DE", taking the lote result into account first. The result is unavailable past 48 h (0364) or never existed (unknown), so the post-window 0420 is the last evidence. One automatic resend, then the hold, keeps a human in the loop for a persistent problem. Operators still release held documents |
| Same CDC, same document row | Guía: resend with the same CDC. `cdc` is unique and immutable, so a second row is impossible |
| Guard door: `submitted -> queued` only when `resent_at` is stamped now (write-once), `transmission_attempts` is exactly +1, the document is not held and one of its lotes is `recovery`, `unknown` or `processed` | As narrow as a trigger can be without time logic (the 48 h rule lives in the recovery store). Every other regression stays forbidden |
| Cap: a document is requeued only while `transmission_attempts + 1` stays below the existing cap (5, `DEFAULT_MAX_TRANSMISSION_ATTEMPTS`), else it is held | The 0301 cap still applies to the shared counter |
| Audit `document.resend_queued` as `system` / `transmission-worker`, in the same transaction | Every resend is traceable |
| Pre-send verification: a resent document is queried by CDC again right before it is put in a lote; 0422 approves it instead, anything but a clean 0420 postpones it | A late approval inside SIFEN is the one way a resend could duplicate a CDC. Check-then-act inside a cycle run leaves seconds, not a cycle interval |
| A document the recovery queued again is owned by no lote while it waits and by the newer lote once it carries it (`recoverableInLote`: latest lote by creation, and `resent_at` after the lote's creation means waiting; both clocks are the database's) | The old lote must not keep asking about, or deciding for, a document that moved on; one document can sit in several lotes and lotes cannot lose members |
| The recover step keeps its place after polling: the requeued document is assembled by the next run, and the pre-send check, not run order, is what protects it | Reordering would delay the first query of an unanswered send for no safety gain |

### Debt left by PRs 8 and 9 (not implemented)

- The warning is logged after the commit, so a crash between the two loses the alert (the worker's held-documents report still lists the document). A throwing logger no longer fails the record (PR 10).

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

PRs 1 to 16 implemented and verified locally (tsc, lint, depcruise, vitest --coverage at each branch tip). Pending: T6.
