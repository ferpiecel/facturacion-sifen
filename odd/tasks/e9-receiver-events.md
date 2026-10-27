# Epic E9: receiver events (conformity, disconformity, unawareness, receipt notice, correction)

- Feature: `e9-receiver-events` · Refs: HU-E9-01, HU-E9-02 (RF-10) · Engram mirror: `odd/e9-receiver-events/tasks`
- TDD: strict (source: `openspec/config.yaml`, `strict_tdd: true`) · runner: Vitest (`pnpm --filter @sifen/api exec vitest run`, thresholds 85%)
- Delivery: `ask-on-risk`, chain `stacked-to-main`; each PR 400 changed lines or less. Migrations: 0058 (E9-01) and 0059 (E9-02) only.

## Objective

The tenant, acting as the **receiver** of a DE/DTE issued by someone else, registers a signed event over that CDC: conformity (total or
partial), disconformity, unawareness (desconocimiento) or receipt notice. HU-E9-02 corrects one of them. The test battery needs 3 of
each kind and 3 corrections.

## Findings (read from the repo, MT v150 pages 119-140 and NT 019)

- The pipeline exists (ADR-0020): `issuer_events` (kind discriminator, state machine, RLS, idempotency columns), `SignPendingEvent`,
  `selectEventBatch`/`SendEventBatch` (batches of at most 15 of any kind), `enviarEventos`, settlement and recovery. ADR-0020 point 1
  already says receiver events "podrán usar la misma tabla". Settlement and recovery are scoped by kind (`cancellation`, `voiding`), so a
  receiver event settles only its own row (status, response) and an `unknown` one waits for an operator, like voidings and nominations.
- `TipsEventXmlBuilder` knows cancellation and voiding. xmlgen 1.0.283 has `generateXMLEventoConformidad|Disconformidad|Desconocimiento|Notificacion`
  (same envelope as the issuer ones: extract `gGroupGesEve`, set our `rEve/@Id`).
- The target is a CDC of **another party's** document: there is no `documents` row. `issuer_events_subject` forces `document_id NOT NULL`
  for every non-voiding kind, so migration 0058 must add `target_cdc` and the per-kind receiver data.
- Receiver identity (`dNomRec`, `dRucRec`, `dDVRec`, `iTipRec = 1`) comes from the tenant's fiscal profile (`tenant_fiscal_profiles`).

## Normative basis (ADR-0012: NT 019 prevails over MT v150)

| Rule                                                                                                                                                                                                                                                                  | Source                              | Platform check                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Event groups `rGeVeConf` (Id, iTipConf 1 total / 2 partial, dFecRecep required if partial), `rGeVeDisconf` (Id, mOtEve 5-500), `rGeVeDescon` (Id, dFecEmi, dFecRecep, receiver identity, mOtEve), `rGeVeNotRec` (Id, dFecEmi, dFecRecep, receiver identity, dTotalGs) | MT 11.5, NT 019 1.1-1.2             | Request validation + builder                                                                                                      |
| Deadline 45 days: DE from `dFecEmi`; DTE from SIFEN approval (4103, 4114, 4157, 4206, 4253, 4263)                                                                                                                                                                     | NT 019 2.1-2.4 and point 5          | Pure rule; start = approval date when the receiver gives it (DTE), else issue date (stricter). Days are configurable (default 45) |
| Compatibility: notice max 1 (4101), not after conformity/disconformity/unawareness for a DTE (4113); conformity max 2, partial then total (4150, 4158), never after unawareness (4156); disconformity max 1 (4200, 4205); unawareness max 1 (4251)                    | NT 019 2.1-2.4, MT 11.6.3-11.6.6    | Pure matrix over the tenant's own non-rejected events of the CDC                                                                  |
| Opposite event after conformity/disconformity is a correction: within 15 days of the first event; the last registered event stands                                                                                                                                    | MT Tabla K, NT 019 2.2-2.3, point 5 | E9-01 refuses it with `receiver-event-needs-correction`; E9-02 registers it                                                       |
| Correction: only over an event SIFEN approved, text justification, one correction per event, 15 days (configurable)                                                                                                                                                   | MT Tabla K                          | E9-02                                                                                                                             |

## Slices

| PR  | Content                                                                                                                                                | Estimated size |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| P1a | Pure domain: `receiver-event-rules` request parsing and validation (kinds, fields, dates)                                                              | about 350      |
| P1b | Same module: 45-day window and compatibility matrix (`validateReceiverEvent`)                                                                          | about 330      |
| P2  | Gateway types (4 receiver kinds) + `TipsEventXmlBuilder` for them; offline tests incl. signing                                                         | about 300      |
| P3  | Migration 0058 (`issuer_events`: kinds, `target_cdc`, `receiver_data`, nullable reason, constraints, open index, guard) + schema + rollback + db tests | about 300      |
| P4a | Signing wiring: `toIssuerEvent` and the signing store load receiver events                                                                             | about 220      |
| P4b | Use case `RegisterReceiverEvent` + UoW port (in-memory spec)                                                                                           | about 400      |
| P4c | Idempotency of the registration (replay, reused key, concurrent commit)                                                                                | about 150      |
| P4d | Drizzle UoW (history, tenant identity, advisory lock, idempotency, audit) + pglite spec                                                                | about 300      |
| P5  | `POST /v1/receiver-events`, module wiring, config, OpenAPI, `docs/configuracion.md`                                                                    | about 390      |
| P5b | Integration guide section in `docs/integracion/eventos.md` (with the E9-02 section)                                                                    | about 60       |
| P6a | HU-E9-02: migration 0059 (`corrects_event_id`, `correction_reason`, one per event, insert guard) + schema + db tests                                   | about 250      |
| P6b | Correction rules (pure): original approved, last conclusive event, not a correction, 15 days, opposite kind                                            | about 300      |
| P6c | Use case `CorrectReceiverEvent` + port (in-memory spec)                                                                                                | about 350      |
| P6d | Drizzle unit of work for corrections + pglite spec                                                                                                     | about 300      |
| P7  | HU-E9-02: `POST /v1/receiver-events/{id}/correct`, OpenAPI, guide (also the E9-01 section), backlog status                                             | about 380      |

## Decisions (tech lead, no PO input needed) and product questions

- SIFEN is the authority (it also sees events registered elsewhere): our checks refuse early, its codes stay final.
- Window days (45) and correction days (15) are configuration, not constants (`RECEIVER_EVENT_WINDOW_DAYS`, `RECEIVER_EVENT_CORRECTION_DAYS`).
- A correction over a correction is refused (stricter reading of "solo un evento de corrección sobre cada evento"). Product question for PO if SIFEN allows more.
- The 4004-style "already confirmed" does not apply. Cancelled-document checks (4115, 4155, 4204, 4264) are SIFEN's: the receiver's platform does not hold the issuer's document.

## Tasks

- [x] T1 P1a request parsing (43be13c, PR #338)
- [x] T1b P1b window and compatibility matrix
- [x] T2 P2 builder (PR below)
- [x] T3 P3 migration 0058
- [x] T4a P4a signing wiring
- [x] T4b P4b use case (ccec384)
- [x] T4c P4c idempotency
- [x] T4d P4d Drizzle unit of work
- [x] T5 P5 endpoint + OpenAPI + config
- [x] T6a P6a migration 0059
- [x] T6b P6b correction rules (116d329)
- [x] T6c P6c use case (ee54e21) and its idempotency (16ebd84)
- [x] T6d P6d Drizzle unit of work (3d681d1)
- [x] T7a HTTP error mapping, incl. `EventKeyCollisionError` -> 409 for both receiver endpoints (ad11645)
- [x] T7b P7 correction endpoint + OpenAPI (72b6a2c)
- [x] T7c integration guide for E9-01 and E9-02 (415161d)

## Progress and handoff

Branch chain (each branches from the previous; worktree `e9-b` develops, `e9-a` is the detached push worktree). Do not rebase onto
main: the orchestrator restacks the chain and renumbers migrations 0058/0059 in the journal at merge time.

| Branch | PR |
|---|---|
| feat/hu-e9-01-receiver-events (P1a) | #338 |
| feat/hu-e9-01-receiver-rules (P1b) | #340 |
| feat/hu-e9-01-receiver-xml (P2) | #342 |
| feat/hu-e9-01-receiver-store (P3, 0058) | #345 |
| feat/hu-e9-01-receiver-signing (P4a) | #348 |
| feat/hu-e9-01-receiver-usecase (P4b) | #350 |
| feat/hu-e9-01-receiver-idempotency (P4c) | #351 |
| feat/hu-e9-01-receiver-unit-of-work (P4d) | #352 |
| feat/hu-e9-01-receiver-endpoint (P5) | #353 |
| feat/hu-e9-02-correction-store (P6a, 0059) | #354 |
| feat/hu-e9-02-correction-rules (P6b) | #355 |
| feat/hu-e9-02-correction-usecase (P6c) | #358 |
| feat/hu-e9-02-correction-idempotency | #359 |
| feat/hu-e9-02-correction-store-uow (P6d) | #360 |
| feat/hu-e9-02-correction-http-errors | #361 |
| feat/hu-e9-02-correction-endpoint (P7) | #362 |
| feat/hu-e9-02-guide | #363 |

Open items: a correction of a correction stays refused (product to confirm); dTiGDE absent in xmlgen output and codes 11 to 14 vs MT
10 to 13 need T0 (Prevalidador); the battery (3 events per kind, 3 corrections) needs the test environment. No backlog status column
exists, so none was changed.
