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

| Rule | Source | Platform check |
|---|---|---|
| Event groups `rGeVeConf` (Id, iTipConf 1 total / 2 partial, dFecRecep required if partial), `rGeVeDisconf` (Id, mOtEve 5-500), `rGeVeDescon` (Id, dFecEmi, dFecRecep, receiver identity, mOtEve), `rGeVeNotRec` (Id, dFecEmi, dFecRecep, receiver identity, dTotalGs) | MT 11.5, NT 019 1.1-1.2 | Request validation + builder |
| Deadline 45 days: DE from `dFecEmi`; DTE from SIFEN approval (4103, 4114, 4157, 4206, 4253, 4263) | NT 019 2.1-2.4 and point 5 | Pure rule; start = approval date when the receiver gives it (DTE), else issue date (stricter). Days are configurable (default 45) |
| Compatibility: notice max 1 (4101), not after conformity/disconformity/unawareness for a DTE (4113); conformity max 2, partial then total (4150, 4158), never after unawareness (4156); disconformity max 1 (4200, 4205); unawareness max 1 (4251) | NT 019 2.1-2.4, MT 11.6.3-11.6.6 | Pure matrix over the tenant's own non-rejected events of the CDC |
| Opposite event after conformity/disconformity is a correction: within 15 days of the first event; the last registered event stands | MT Tabla K, NT 019 2.2-2.3, point 5 | E9-01 refuses it with `receiver-event-needs-correction`; E9-02 registers it |
| Correction: only over an event SIFEN approved, text justification, one correction per event, 15 days (configurable) | MT Tabla K | E9-02 |

## Slices

| PR | Content | Estimated size |
|---|---|---|
| P1a | Pure domain: `receiver-event-rules` request parsing and validation (kinds, fields, dates) | about 350 |
| P1b | Same module: 45-day window and compatibility matrix (`validateReceiverEvent`) | about 330 |
| P2 | Gateway types (4 receiver kinds) + `TipsEventXmlBuilder` for them; offline tests incl. signing | about 300 |
| P3 | Migration 0058 (`issuer_events`: kinds, `target_cdc`, `receiver_data`, nullable reason, constraints, open index, guard) + schema + rollback + db tests | about 300 |
| P4a | Signing wiring: `toIssuerEvent` and the signing store load receiver events | about 220 |
| P4b | Use case `RegisterReceiverEvent` + UoW port (in-memory spec) | about 400 |
| P4c | Idempotency of the registration (replay, reused key, concurrent commit) | about 150 |
| P4d | Drizzle UoW (history, tenant identity, advisory lock, idempotency, audit) + pglite spec | about 300 |
| P5 | `POST /v1/receiver-events`, module wiring, OpenAPI, guide, `docs/configuracion.md` | about 350 |
| P6 | HU-E9-02: migration 0059 (`corrects_event_id`, `correction_reason`, one per event) + correction rules + use case | about 400 |
| P7 | HU-E9-02: `POST /v1/receiver-events/{id}/correct`, OpenAPI, guide, backlog status | about 300 |

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
- [ ] T4d P4d Drizzle unit of work
- [ ] T5 P5 endpoint + docs
- [ ] T6 P6 correction (0059) rules + use case
- [ ] T7 P7 correction endpoint + docs

## Progress and handoff
(none yet)
