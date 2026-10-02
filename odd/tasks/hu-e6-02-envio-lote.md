# HU-E6-02 — Send the lote and store the protocol

## Objective

Send a built `Lote` to SIFEN (`siRecepLoteDE`) and persist the outcome: 0300 stores
`dProtConsLote`; 0301 records the reason; no response never resends (HU-E6-04 recovers).
Sources: backlog HU-E6-02, plan §8.1 "Envío y consulta" and §8.5, ADR-0007.

## Settings

- TDD: strict (RED commit alone, GREEN, refactor). Runner: vitest (`@sifen/api`).
- Delivery: slices <= 400 changed lines (excluding `pnpm-lock.yaml`). Branch per slice.
- Reuse: `LoteBuilder`/`Lote` (transmission/domain), `SifenGateway` port + `FakeSifenGateway` + `sifenScenarios`.

## Slices

- [x] **S1 — `SendLote` application service (api, no migration).** Claims the lote through a
      `LoteDispatchStore` port (atomic `pending -> sending`; a lote already claimed is never sent
      again), calls `gateway.enviarLote`, maps: 0300 -> `sent` + `dProtConsLote`; 0301 -> `rejected`
  - code and reason; timeout/transport error or any unexpected/ambiguous response (other code,
    0300 without protocol) -> `unknown`, never resent. In-memory store fake in tests.
    Acceptance: one gateway call per lote under every outcome; replay of a claimed lote makes no
    call; cdcs/dId forwarded to the gateway.
- [ ] **S2 — Persistence adapter for `LoteDispatchStore`.** `lotes_sifen` (plan §8 data model:
      `numero_lote_sifen`, `estado`, `enviado_at`, `proxima_consulta_at`, `vence_consulta_at`) needs a
      migration for the states `pending|sending|sent|rejected|unknown` plus `motivo`/`codigo_respuesta`
      columns; atomic claim via `UPDATE ... WHERE estado='pending'`. Migration proposed to the tech
      lead before writing. Sets `proxima_consulta_at` = sent + 10 min, `vence_consulta_at` = sent + 48 h.
- [ ] **S3 — Real HTTP/mTLS gateway adapter for `enviarLote`** (tenant certificate, siRecepLoteDE
      envelope via PR #74's lote message). Blocked on the real certificate / PoC against sifen-test.
- [ ] **S4 — Worker wiring** (`lote-build` queue picks lotes, calls `SendLote`, schedules the first
      poll; 0301 due to RUC block -> pause tenant, HU-E6-05).

## Decisions (S1)

- `sending` is persisted BEFORE the call: a crash mid-call leaves `sending`, which recovery
  (HU-E6-04) must treat as `unknown`. Never retry from `sending`.
- Transport errors (not only timeouts) map to `unknown`: after TLS/network failure we cannot
  prove SIFEN did not receive the lote (plan §8.1 step 2, ADR-0007).
