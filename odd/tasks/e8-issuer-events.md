# Epic E8: issuer rejections and events (event infrastructure, cancel, void ranges, correct and resend, nominate)

- Feature: `e8-issuer-events` · Refs: HU-E8-01, HU-E8-02, HU-E8-03, HU-E8-04, HU-E8-05 (F2; RF-07, RF-08, RF-09, RF-27)
- Engram mirror: `odd/e8-issuer-events/tasks`
- TDD: strict (source: `openspec/config.yaml`, `strict_tdd: true`) · runner: Vitest (`pnpm --filter @sifen/api exec vitest run`, thresholds 85%)
- Delivery: `ask-on-risk`, chain `stacked-to-main`; each PR about 400 changed lines or less (advisory; the hard limit of 400 in CLAUDE.md holds).
- Size: five stories, about 5,900 authored lines in 16 PRs plus this plan (see "Sizing"). Per story: E8-04 XXL (7), E8-01 XXL (7), E8-02 XL (6), E8-03 XL (6), E8-05 L (5).
- Status: plan only. No source changed by this document. The first slice (HU-E8-04 A, XML and signing adapters) can start now: it has no open product decision.

## Objective

Let the platform act on a DE after it was sent: cancel an approved DTE inside its window, void numbers that will never be used, correct and resend a
rejected DE, and nominate an FE issued to an unnamed receiver. All four are SIFEN **events** (`siRecepEvento`): signed XML, sent in batches of up to 15,
answered per event. So the work is one event pipeline (HU-E8-04) plus four commands that use it.

## Problem (gap analysis)

### What exists today

| Piece | Where | State |
|---|---|---|
| `enviarEventos` operation on the gateway port | `packages/sifen-gateway/src/port.ts`, `soap/requests.ts` (`buildEventosMessage`, 1 to 15 events, throws `RangeError` otherwise), `soap/response-parsers.ts` (`parseEventos`), `soap/endpoints.ts` (`/de/ws/eventos/evento.wsdl`), `fake/fake-sifen-gateway.ts` (1 to 15 guard, scripted answers) | Done and tested at the transport level. Result type `SifenEventosResult { resultados: [{ id, dEstRes, mensajes }] }`. Each event string is embedded in `dEvReg`. The fake has "no verified code" for events: now known, **0600** "Evento registrado correctamente" (MT 11, BU01). |
| Event XML generation | `facturacionelectronicapy-xmlgen@1.0.283`, `dist/services/jsonEventoMain.service.js` | Exists in the library, **not used**: `packages/sifen-tips` has only the DE builder, the QR generator and the DE signer. No port for events in `emission-ports.ts`. |
| Event signing | `facturacionelectronicapy-xmlsign@1.0.28`, `signXMLEvento(xml, file, password, nodeMode)` | Exists, not wrapped. `TipsXmlSigner` signs only DEs. |
| Event XSD | `packages/sifen-xsd/vendor/` | **Missing.** Only `siRecepDE_v150.xsd` and the DE types are vendored; `siRecepEvento_v150.xsd` and `resRecepEvento_v150.xsd` are not. Events cannot be XSD-validated offline today. |
| Statuses | `documents.status` CHECK (0021): `cancelled`, `number_voided`, `corrected` already allowed; `documents_status_rank` (0024) puts `approved` (4) below `cancelled`, `number_voided`, `corrected` (5) | `approved -> cancelled` and `rejected -> number_voided` pass the forward-only guard. **`corrected -> signed` does not** (rank 5 to 1), and `payload`, `signed_xml` and `signed_at` are immutable or write-once (0034), so "correct and resend with the same CDC" cannot be written on the same row today. |
| Approval instant | `documents` | **No column.** `updated_at` moves on any update; the timeline (`portal-documents/domain/document-events.ts`) admits "there is no status history table yet". The 48 h and 168 h cancel windows count from SIFEN's approval (4009, 4010), so we need the instant. `dFecProc` is not parsed from the lote result either. |
| Event rows | schema | **None.** The plan v1.1 (section 7.3) names `eventos_sifen (id, tenant_id, tipo, documento_id NULL, rango JSONB NULL, lote_eventos_id, estado, respuesta_sifen, firmado_at)`. |
| Numbering | `packages/db/src/document-number.ts`, `tenant_document_sequences` | Sequences are per (tenant, environment, timbrado, establishment, point, type, series). Nothing records voided ranges. A number that burned without a document (a gap) has no row. |
| Worker | `TransmissionCycle` (`sign`, `assemble`, `send`, `poll`, `recover`) | No event step. The plan names `EventBatchWorker` (v1.1 section 5). |
| Webhooks | `webhooks/domain/webhook-document-events.ts` | `document.cancelled` and `document.number_voided` are already mapped to the statuses; `corrected` produces none. No nomination event, no deadline warning (`document.transmission_deadline_warning` is only in the plan). |
| NCE | HU-E7-01, ADR-0019 | `credit-note-unnamed-receiver` (1331) refuses an NCE over an FE issued to "Sin Nombre"; 2442 (receiver must equal the nominated one) is out of scope until HU-E8-05. `cancelled` and `number_voided` already release credit in the 2417 sum. |

### What the TIPS library gives and does not give (read from `xmlgen@1.0.283` and `xmlsign@1.0.28`)

- `generateXMLEventoCancelacion`, `...Inutilizacion`, `...Nominacion` (and the receiver ones, for E9) return a **complete SOAP envelope**
  (`env:Envelope/env:Body/rEnviEventoDe/{dId, dEvReg/gGroupGesEve/rGesEve/rEve}`), not the bare event. The batch envelope belongs to our gateway
  (`buildEventosMessage`), so the adapter must extract `gGroupGesEve`.
- `rEve/@Id` is hardcoded to `1`. MT GDE003 and the response (`gResProcEVe/id`) need an id that is unique per event and that we choose (N 1 to 10),
  so the adapter sets it before signing and the store keeps it.
- `signXMLEvento` expects exactly that envelope (it reads `rEnviEventoDe/dEvReg/gGroupGesEve/rGesEve/rEve/@Id`), signs `rEve` and puts the
  `Signature` after it. The adapter builds, signs and extracts; it must not sign the bare `gGroupGesEve`. To be proven by a test (slice A).
- Validations in the library are length and presence checks only: cancel motive 5 to 500, CDC 44 characters; inutilización needs timbrado (8), establishment (3),
  point (3), `desde <= hasta`, type, motive 5 to 500, optional series (2). **No** 1000-number limit, no deadline, no status or association rule: those are ours.
- Nomination (`tipoEvento` 15, NT 014/015/027) validates country, operation type (1 B2B, 2 B2C, 4 B2F), taxpayer or not, identity document type, address
  fields. It does not know the rules 4453, 4454, 4468, 4469 (they need our `documents`).
- Not proven yet: that the signed event the library produces is accepted by the Prevalidador or the test environment (T0, blocked on environment access).

## Normative basis

Precedence follows ADR-0012. Citations are to `docs/referencia/dnit/` (MT = Manual Técnico v150, extracted text checked for this plan).

| Rule | Source | Platform check |
|---|---|---|
| Events are one XML per event, each signed; sent in batches of up to 15 of any type (issuer and receiver) | MT 11 (event management specifications); MT 9.5; plan v1.1 2.2 | Batcher: at most 15 per `enviarEventos`, one issuer per batch (one certificate signs all of them, 4006) |
| `siRecepEvento` is synchronous; success is `dCodRes` 0600; each event is answered in `gResProcEVe` (`dEstRes`, `dProtAut`, `id`, messages) | MT 9.5.3, schema 14; MT BU01 | Per-event settlement keyed by our event `id`; the batch has no lote-level code |
| Event general group: `rEve@Id` (N 1-10), `dFecFirma`, `dVerFor`, `dTiGDE` (1 cancel, 2 void, 15 nominate per xmlgen), `gGroupTiEvt`, `Signature` | MT 11.5, GDE001 to GDE008; xmlgen | Adapter, slice A |
| Cancel: `rGeVeCan` with `Id` = CDC (GEC002) and `mOtEve` 5 to 500 (GEC003) | MT 11.5.1 | Request validation |
| 4001 invalid CDC, 4002 CDC not approved in SIFEN, 4003 same event already requested | MT 11.6.1 | Pre-checks: status is `approved` or `approved_with_observations`; one open cancel per document |
| 4006 signer RUC must be the issuer's; 4007 revoked certificate; 4008 signature date not after SIFEN approval | MT 11.6.1 | Sign with the tenant's own certificate (ADR-0010); `dFecFirma` taken at signing |
| **4009 FE: signature date within 48 h of SIFEN approval; 4010 AFE, NCE, NDE, NRE (CDC type 04, 05, 06, 07): 168 h** | MT 11.6.1 | Deadline rule over `approved_at` (new column), checked before signing and again at send; refuse with a stable rule name |
| 4004 (receiver already confirmed) no longer blocks | NT 025 (in force 2025-04-28) | Do **not** pre-check receiver conformity |
| DTEs associated to the document are cancelled from the last to the first | plan v1.1 2.2 and 8.3; backlog HU-E8-02 | Refuse when a live associated DTE exists (`associated_cdc` index, ADR-0019); the integrator cancels the NCE first |
| Void: `rGeVeInu` with `dNumTim` (8), `dEst` (3), `dPunExp` (3), `dNumIn` (7), `dNumFin` (7), `iTiDE`, `mOtEve` 5 to 500, optional `dSerieNum` | MT 11.5.1 (GEI001 to GEI008) | Request validation and padding |
| Void errors: 4065 DTE exists in the range, 4066 number already voided, **4067 more than 1000 numbers**, 4068 end not after start (the library accepts `desde = hasta`; the plan says `hasta > desde`: confirm, see decisions), 4052 to 4055 and 4060 timbrado, establishment, point, type | MT 11.6.2 | Pre-checks against our `documents` and the new voided-ranges table; the timbrado ones come from `fiscal-config` |
| **Void deadline: the first 15 days of the following month, and until the end of the timbrado's validity**; the number must not exist in SIFEN | MT section 11, Tabla J (issuer events summary), row 2; plan v1.1 2.2 | Deadline calculator and an alert (not a hard refusal: SIFEN decides, the date is config, see decisions) |
| Rejected DE: same CDC if the correction does not change any CDC field; otherwise void the number and issue a new DE | MT 6.5; plan v1.1 8.0 | The classifier compares the CDC components of the old and corrected payloads |
| Nominate: one event per CDC (4453); the CDC must be an FE of the issuer (4454, 4468); the FE receiver must be unnamed, D208 = 5 (4469); fields by receiver nature (4456 to 4478) | NT 014 (validations), NT 015, NT 027 (identity document codes) | Pre-checks over `documents` and its stored payload |
| NCE or NDE over a nominated FE must carry the nominated receiver (H004i, 2442) | NT 015 | Follow-up in the NCE rules once nominations are stored |
| Test battery: 5 cancellations (any DE); voids: 2 FE, 1 NCE, 1 NDE, 1 AFE; 1 event web service communication | Guía de Pruebas e-Kuatia 2026-02; plan v1.1 section on the battery | T11 (blocked on environment) |

Gaps in the sources, to confirm and not assumed: whether the Prevalidador accepts the library's event structure as is (including `dVerFor`); whether
`approved_with_observations` can be cancelled (we follow the plan: yes, it is an approval); whether the 15-day void window is enforced by SIFEN or only
informative (MT Tabla J, "plazo del sistema"; Tabla K is the receiver-corrections table); the exact semantics of 4068 when the range has one number; the event XSD (not vendored).

## Dependency order and PR slices

Event infrastructure first (everything signs, stores and sends events), then the four commands. After slice D of HU-E8-04, HU-E8-02, HU-E8-03 and
HU-E8-05 are independent of each other, so they can run as parallel worktrees; HU-E8-01 goes last because its CDC-changing branch calls the void command.

| PR | Story | Content | Estimated size | Depends on |
|---|---|---|---|---|
| E8-04 A1 | HU-E8-04 | `IssuerEvent` types, `EventXmlBuilder` port and `TipsEventXmlBuilder` (cancel and void; bare `gGroupGesEve` with our `Id`); nomination joins in E8-05 A (PR #267) | about 210 | none |
| E8-04 A2 | HU-E8-04 | `EventSigner` port and `TipsEventSigner`; offline e2e that verifies the signatures inside the batch envelope (PR #269) | about 250 | A1 |
| E8-04 A3 | HU-E8-04 | Vendor `siRecepEvento_v150.xsd` and its closure, add the `siRecepEvento` schema to `validateXml` | about 150 | A2 |
| E8-04 B | HU-E8-04 | ADR-0020 and migration: `issuer_events` (one table, `kind` discriminator; tenant RLS, kind, document or range, event id sequence, signed XML, status, SIFEN answer) and `sifen_event_batches`; rollback; Drizzle schema; RLS coverage and guard tests | about 400 | A |
| E8-04 C | HU-E8-04 | Domain and use case: `EventBatcher` (at most 15, one issuer, no repeated `eventId` in a batch, with a test), `SendEventBatch` over `gateway.enviarEventos`, per-event response handling (0600, rejections keep SIFEN's code), no resend of an unanswered batch (recover like lotes), Drizzle store | about 400 | B |
| E8-04 D | HU-E8-04 | Worker: events step in `TransmissionCycle`, sign-then-batch, audit entries, webhook events for event outcomes, `docs/operacion.md` section | about 300 | C |
| E8-02 A | HU-E8-02 | Migration `documents.approved_at` (write-once, set when SIFEN approves; backfill from `updated_at` for approved rows is **not** safe, see decisions); settle code writes it; `dFecProc` parsed if the lote answer carries it | about 250 | E8-04 B |
| E8-02 B | HU-E8-02 | Domain rules and use case: status, 48 h / 168 h deadline, one open cancel, live associated DTEs refused; enqueue a signed cancel event | about 400 | E8-02 A, E8-04 C |
| E8-02 C | HU-E8-02 | `POST /v1/documents/{id}/cancel`, 202, idempotent; settlement `approved -> cancelled` on 0600; `document.cancelled` webhook; OpenAPI, guide | about 350 | E8-02 B, E8-04 D |
| E8-03 A | HU-E8-03 | Migration `voided_number_ranges` (RLS) and the `number_voided` marking; deadline calculator and range rules (domain, pure) | about 400 | E8-04 B |
| E8-03 B | HU-E8-03 | `POST /v1/numbering/inutilize`: use case, pre-checks (1000, no approved or in-flight DE in the range, no overlap), event enqueue, settlement marks matching rejected documents `number_voided` | about 400 | E8-03 A, E8-04 D |
| E8-03 C | HU-E8-03 | Deadline alert (worker watch plus webhook) over gaps and rejected numbers; docs, OpenAPI | about 250 | E8-03 B |
| E8-05 A | HU-E8-05 | Migration (nominated receiver stored per FE, one per CDC) and the domain rules 4453, 4454, 4468, 4469 and the receiver fields by nature | about 350 | E8-04 B |
| E8-05 B | HU-E8-05 | `POST /v1/documents/{id}/nominate`, event enqueue, settlement stores the nominated receiver; NCE/NDE take it into account (2442) and `credit-note-unnamed-receiver` lets a nominated FE through; docs | about 400 | E8-05 A, E8-04 D |
| E8-01 A | HU-E8-01 | ADR-0021 (how a rejected row is corrected: guarded in-place rewrite versus a replacement row) and the migration it implies; CDC-impact classifier (pure) | about 350 | E8-04 D |
| E8-01 B | HU-E8-01 | `POST /v1/documents/{id}/correct`, same-CDC path: re-validate, rebuild XML, re-sign, requeue; resend preflight (E6-04) unchanged | about 400 | E8-01 A |
| E8-01 C | HU-E8-01 | CDC-changing path: void the old number through E8-03, issue the replacement, link both; webhook; docs | about 400 | E8-01 B, E8-03 B |
| E8 close | all | Guide `docs/integracion/eventos.md`, backlog and roadmap status, T0 and T11 left open | about 150 | all |

Total about 5,900 authored lines including tests and docs. Generated `docs/api/openapi.json` is declared as generated in the PR description. The
planning PR is docs only.

## Tasks

- [ ] T0 Evidence with the test environment: Prevalidador check of a signed cancel, void and nominate event; the 15-day void window; `approved_with_observations` cancel; `dVerFor` value; the motive length (MT 11.1.1 says free text of up to 150 characters for a void, the field tables say 5 to 500: until confirmed, the platform accepts 5 to 150 for a void); `rEve` carries no `dTiGDE` in xmlgen output. **Blocked on test-environment access and a certificate.**
- [x] T1 HU-E8-04 A1 and A2: event ports and TIPS adapters (builder and signer), offline tests (PRs #267, #269). ADR-0020 moved to B; nomination builder to E8-05 A.
- [ ] T1b HU-E8-04 A3: vendor the event XSD closure.
- [ ] T2 HU-E8-04 B: events and batches migration, schema, rollback, RLS tests.
- [ ] T3 HU-E8-04 C: batcher, send use case, response handling, store.
- [ ] T4 HU-E8-04 D: worker step, audit, webhooks for event outcomes, operations doc.
- [ ] T5 HU-E8-02 A to C: `approved_at`, cancel rules and use case, endpoint and settlement.
- [ ] T6 HU-E8-03 A to C: voided ranges, inutilize endpoint, deadline alert.
- [ ] T7 HU-E8-05 A and B: nomination storage, rules, endpoint, NCE interplay.
- [ ] T8 HU-E8-01 A to C: correction ADR and migration, same-CDC resend, CDC-changing reissue.
- [ ] T9 Close: guide, backlog and roadmap, T0 and T11 left open.
- [ ] T10 End to end and battery (5 cancellations, voids by type, one event web service call): simulator first, then the test environment. **Blocked on environment access.**

## Constraints

- Strict TDD: failing test first, then code, with observed RED and GREEN recorded per slice.
- Hexagonal rules hold: event ports in `application/ports/`, Drizzle stores in `infrastructure/`; rules are pure functions in `domain/`. Only `packages/sifen-tips` imports `facturacionelectronicapy-*` (ADR-0015).
- Every new table has `tenant_id` with `ENABLE` and `FORCE ROW LEVEL SECURITY` and a `FOR ALL` policy; the RLS coverage test must stay green. Data access through `withTenantTransaction`.
- A signed event is write-once (like `signed_xml`); an event answered by SIFEN is never resent. An unanswered batch is recovered by querying, not resent (same discipline as lotes, HU-E6-04).
- The certificate and its password stay in memory (ADR-0009); logs carry ids, counts and error classes, never XML.
- A refused command burns nothing: all pre-checks run before an event id is taken or an event stored.
- No new dependency. Test PKI only.

## Technical decisions (to record in ADR-0020 and ADR-0021; open ones are marked)

| # | Decision | Rationale |
|---|---|---|
| D1 | One table `sifen_events` for all issuer events, `kind` in (`cancellation`, `voiding`, `nomination`), nullable `document_id`, `range` jsonb for voids, `event_id` per (tenant, environment) from a counter like `dId`, status `pending / signed / sent / approved / rejected / unknown` | Plan v1.1 7.3; the response is keyed by `id`; E9 receiver events can reuse it later. **Open:** a separate table per kind is simpler to constrain but triples RLS surface. |
| D2 | `sifen_event_batches` holds the send (`dId`, status, answer) and events point to it | Mirrors `lotes`: the same recovery rules apply to an unanswered send |
| D3 | The adapter returns the bare `gGroupGesEve` and sets `rEve/@Id` before signing; signing goes through a new `EventSigner` port (`TipsEventSigner`) | Library constraints above |
| D4 | The 48 h / 168 h deadline is checked at command time over `documents.approved_at`, and re-checked when the batch is built (an event signed late is refused locally instead of costing a 4009) | Cheap, keeps the integrator's error synchronous |
| D5 | `approved_at` is SIFEN's processing instant when the answer carries it (`dFecProc`, parsed as America/Asuncion time), else the settle time; write-once, only set with the transition into `approved` or `approved_with_observations`. Old rows have none: at cancel time the platform asks SIFEN (`consultarDE`) once, stamps the row, and applies a safety margin to the window | `updated_at` is not evidence. **Decided** (tech lead): lazy refresh at cancel time, no one-time backfill. |
| D6 | Cancel and void settle on 0600 only (`approved -> cancelled`, rejected or gap numbers -> voided); any other answer leaves the document as it was and keeps SIFEN's code on the event | SIFEN is the authority; local state follows the answer |
| D7 | A cancel with a live associated DTE is refused (`has-live-associated-documents`), listing the CDCs, instead of cascading | The integrator keeps control of which fiscal documents are cancelled; plan says "exigir cancelar primero los asociados" |
| D8 | Voided ranges are rows in `voided_number_ranges`; numbers that already have a rejected document move it to `number_voided`; the numbering allocator never reuses a number inside a recorded range | Gaps have no document row to carry a status |
| D9 | Correct and resend (E8-01): decided in ADR-0021 before code. The guard forbids `corrected -> signed`, and `payload` and `signed_xml` are immutable, so the options are a replacement row linked by `corrects_cdc` or a narrowly guarded rewrite for `rejected` rows only. **Open**, ADR first. | Neither option is free; it needs a migration and a review |
| D10 | Endpoints reuse `Idempotency-Key`, 202 and `documents:write`; `POST /v1/documents/{id}/cancel`, `POST /v1/numbering/inutilize`, `POST /v1/documents/{id}/nominate`, `POST /v1/documents/{id}/correct` | ADR-0011 and the plan's API list (plan 8.3, 8.4, 19). **Open:** a dedicated scope for destructive fiscal actions. |
| D11 | Event webhooks reuse the document types where the status changes (`document.cancelled`, `document.number_voided`) and add `event.rejected` for a refused event; the nomination adds `document.nominated` | No new envelope; one event per (document or event, type) as today |
| D12 | The fake gateway answers events with 0600 per event by default; rejections are scripted by the tests | Removes the "no verified code" caveat in the fake |

## Sizing

Team table (points), per story:

| Story | Lines (about) | Lines pts | Layers | Migration | Sensitive | Total | Size | Budget (target / alarm) |
|---|---|---|---|---|---|---|---|---|
| HU-E8-04 | 1,450 | 3 | 2 (3 or more) | 1 | 1 (signing) | **7** | XXL | 60M / 100M |
| HU-E8-02 | 1,000 | 3 | 2 | 1 | 0 | **6** | XL | 50M / 60M |
| HU-E8-03 | 1,050 | 3 | 2 | 1 | 0 | **6** | XL | 50M / 60M |
| HU-E8-05 | 750 | 2 | 2 | 1 | 0 | **5** | L | 30M / 45M |
| HU-E8-01 | 1,150 | 3 | 2 | 1 | 1 (resend, signing) | **7** | XXL | 60M / 100M |

Sum about 5,400 plus the close PR and plan, about 5,900 with docs. HU-E8-04 is first and the biggest risk: its alarm is the checkpoint for the
whole epic. The first candidate to cut at an alarm is T10 (the battery, blocked on the environment), then the deadline alert of E8-03 C; never the
pre-checks, the signing tests or review fixes. Record cumulative tokens at each PR merge.

## Route declaration

Recorded per task when it starts. Expected: T1 inline by the writer (2 to 4 files, a new adapter pair and its tests); T2 inline (migration, schema, one test block);
T3 and T4 one delegated writer each (several files across layers); T5 to T8 one delegated writer per PR, reading this plan and the ADR first;
mapping of the transmission cycle for T4 (4 or more files) goes to one narrow exploration worker. Tests, builds and the Postgres run use fresh per-action workers.

## Acceptance criteria

- A signed cancel, void and nominate event is built by the adapter, carries our `rEve@Id`, and the signature verifies against the test PKI.
- A batch never holds more than 15 events; a 16th is left for the next batch; an unanswered batch is not resent.
- Cancel: an FE approved 47 h ago is accepted (202) and settles `cancelled` on 0600; at 49 h the answer is 422 `cancel-window-expired` (4009); an NCE has 168 h (4010); a document with a live NCE is refused (`has-live-associated-documents`); a receiver's prior conformity does not block it.
- Void: a range of 1000 is accepted, 1001 is refused (4067); a range that contains an approved or in-flight DE is refused (4065); overlap with a voided range is refused (4066); rejected documents inside the range become `number_voided`; numbers inside a voided range are never allocated again.
- Nominate: a second event on the same CDC is refused (4453); a non-FE (4454), a foreign FE (4468) or an FE with a named receiver (4469) is refused; fields follow the receiver nature.
- Correct: a correction that leaves the CDC components unchanged resends with the same CDC; one that changes them voids the old number and issues a new DE, linked.
- Every command is idempotent by `Idempotency-Key`, tenant-isolated (RLS), audited, and refused commands burn no number or event id.
- `pnpm verify`, `pnpm --filter @sifen/db test:postgres` and the coverage thresholds pass; the OpenAPI test passes after regeneration.

## Decisions

### Product decisions (for the product owner)

Checked first against the PRD (`docs/prd/prd.md`, RF-07 to RF-09, RF-27), the backlog (E8 criteria), plan v1.1 (2.2, 8.0, 8.3, 8.4, 8.6, 19) and NT 014, 015, 025, 027. They already settle: the cancel windows and that
conformity does not block it, associated DTEs from last to first, the 1000-number limit and the 15-day void deadline, automatic void and reissue when a
correction changes the CDC, and the nomination rules. What is **not** settled anywhere:

- **P1 Who may cancel, void, correct and nominate.** The PRD lists portal roles (`owner`, `admin`, `emisor`, `lector`) and the API has one `documents:write` scope, but no document says which role may run a destructive fiscal action. Proposed default (not blocking slice A to D): owner, admin and emisor may; lector may not; one scope for API keys at first.

### Technical decisions still open (tech lead, no product input needed)

D1 one table versus one per kind; D5 backfill of `approved_at` for rows approved before the column exists; D9 how a rejected row is corrected (ADR-0021,
blocks E8-01 B); D10 a dedicated scope. The event XSD is also missing: obtain `siRecepEvento_v150.xsd` and `resRecepEvento_v150.xsd` from the DNIT package
and vendor them with a checksum in `packages/sifen-xsd` (blocks only the XSD check of slice A, not the adapters).

Decided by the tech lead (2026-10-16): **P2 (void deadline) is technical, not product:** when the 15-day window has passed with the timbrado still valid, warn, send anyway and show SIFEN's answer; D1 one `issuer_events` table with a type discriminator; D5 `dFecProc` parsed as Asunción time for new approvals, old rows refreshed lazily with `consultarDE` at cancel time with a safety margin; D9 decided in ADR-0021 when E8-01 starts; D10 no new scope for the MVP (existing write scope and the portal role matrix; the PO decides the roles).

Closed here (technical): D2, D3, D4, D6, D7, D8, D11, D12. They are recorded in ADR-0020 by slice B.

## Progress and next step

- Done: gap analysis over the transmission module, the gateway port and SOAP layer, `packages/sifen-tips`, the installed `xmlgen` and `xmlsign`, the document guards and
  statuses, the webhook mapping, the MT v150 (9.5, 11 and 6.5, Table K), NT 014, 015, 025 and 027, and plan v1.1.
- Done: HU-E8-04 A1 and A2 (#267, #269). The event XSD is obtainable from `ekuatia.set.gov.py` (`siRecepEvento_v150.xsd` includes `Evento_v150.xsd`); `resRecepEvento_v150.xsd` is not published under that name (404).
- Next: HU-E8-04 B (ADR-0020 and the `issuer_events` migration), then A3 (XSD vendoring).

## Checks and evidence

- None run for implementation; this document changes no source. Pending: Prevalidador confirmation (T0), the adapters (T1) and the battery (T10).
