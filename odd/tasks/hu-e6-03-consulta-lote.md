# HU-E6-03 — Query the lote result

## Objective

Poll `siResultLoteDE` for a sent lote: first query 10 min after sending, then every >= 10 min;
0361 keeps polling; 0362 processes each DE by `dEstRes` (Aprobado / Aprobado con observación /
Rechazado) and updates each document's status; 0364, 0360 or past the 48 h window hands off to
HU-E6-04 recovery (query by CDC). Sources: backlog HU-E6-03, plan v1.1 §8.1 (steps "LoteResultPollWorker"),
§8 data model (`vence_consulta_at`), plan line 345 (`dEstRes`), ADR-0007, `packages/sifen-gateway/src/codes.ts`.

## Settings

- TDD: strict (RED commit alone, GREEN, refactor). Runner: vitest (`@sifen/api`).
- Delivery: slices <= 400 changed lines (excluding `pnpm-lock.yaml`).

## Slices

- [x] **S1 — `PollLoteResult` application service (no migration).** Ports `LotePollStore`
      (`load` + atomic `record`), `gateway.consultarLote` called once per due lote, injected clock.
      Outcomes: `not-found`, `not-pollable`, `not-due` (no gateway call), `pending` (0361 or a
      transient failure; `nextPollAt = now + 10 min`, never earlier), `processed` (0362; per-DE
      `approved | approved_with_observations | rejected` + code/message; DEs missing from the answer
      or with an unknown `dEstRes` go to `needsRecovery`), `recovery` (0364, 0360 or `now >
      pollDeadlineAt`; the deadline check makes no call). In-memory store fake in tests.
- [ ] **S2 — Drizzle `LotePollStore` + migration 0024.** `lotes.status` gains `processed` and
      `recovery`; `lotes_guard` allows `sent -> processed | recovery` (and `sent -> sent` stays a
      non-transition for reschedules); `lotes` gets `last_polled_at`/`poll_attempts` only if needed.
      Documents `submitted -> approved | approved_with_observations | rejected` in the same
      transaction as the lote update (requires the documents guard to be checked; emission owns
      migration 0023).
- [ ] **S3 — Worker wiring** (`LoteResultPollWorker`: find lotes with `next_poll_at <= now`, dId from
      the tenant sequence, schedule). Needs the gateway HTTP adapter (HU-E6-02 S3).
- [ ] **S4 — HU-E6-04 recovery consumes `recovery` lotes and `needsRecovery` CDCs.**

## Decisions (S1)

- 0360 (lote inexistente) -> recovery, like 0364: plan §8.1 lists "0364 (pasadas 48 h) o 0360 ->
  consultar cada CDC con siConsDE".
- Unexpected code or a gateway error -> `pending` with the reason: a query is read-only and safe to
  repeat; the 48 h deadline eventually forces recovery.
- `dEstRes` matched accent/case-insensitively; anything else is not guessed and goes to `needsRecovery`.
- The request `dId` is supplied by the caller (tenant sequence), not generated here.
