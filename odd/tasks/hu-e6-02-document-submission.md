# HU-E6-02 (follow-up) — From accepted documents to a sent lote

## Objective

Close the gap between `documents` (accepted/signed) and a `sent` lote: assemble ready documents into
`pending` lotes, queue them, and mark them `submitted` once SIFEN received the lote, so
`PollLoteResult` (HU-E6-03) can settle them. Sources: ADR-0007 (lote as the main path; no CDC in two
lotes in process), plan v1.1 §8.1, backlog HU-E6-01/02/03.

## Settings

- TDD: strict (RED commit alone, GREEN, refactor). Runner: vitest (`@sifen/api`, `@sifen/db`).
- Delivery: slices <= 400 changed lines. Migration number for this work: 0025.

## Findings

- `documents` has no column for the signed XML (nor `signed_at`): `invoice-signing.ts` returns
  `{ xml, signedAt }` but nothing persists it, and nothing moves `accepted -> signed`. The QR group
  (`gCamFuFD`) is added after signing, so the XML to store is the final signed+QR one.
- `documents_guard` (0024) ranks accepted < signed < queued < submitted < outcomes: `queued -> submitted`
  is allowed, regressions are not.
- `LoteBuilder.isInProcess` is synchronous, so the assembler preloads the CDCs that are in process.

## Slices

- [x] **S1 — `LoteAssembler` application service (no migration).** Port `LoteAssemblyStore`
      (`readyDocuments`, `cdcsInProcess`, atomic `createLote`), `measureMessage` injected. Groups ready
      documents by (RUC, document type), fills `LoteBuilder`, starts a new lote on `lote-full` /
      `size-exceeded`, skips `cdc-in-process` / `duplicate-cdc` / a document too big alone, and reports
      conflicts when a document stopped being ready between read and create (`createLote` returns null).
- [x] **S2 — Dispatch store marks documents `submitted`.** `record('sent')` also moves the lote's
      `queued` documents to `submitted` in the same tenant transaction (no migration; pglite test).
- [x] **S3 — Migration 0025 + Drizzle `LoteAssemblyStore`.** `documents.signed_xml text` and
      `signed_at timestamptz` (write-once once set, added to `documents_guard` keeping every existing
      rule); adapter: ready = status `signed`|`queued` with `signed_xml`, `cdcsInProcess` over
      `lote_documents` x `lotes` with status in (`pending`,`sending`,`sent`,`unknown`,`recovery`);
      `createLote` inserts the lote (tenant environment) + links and moves documents `signed -> queued`
      conditionally, returning null (rollback) if any is no longer ready.
- [ ] **S4 — Signing integration (`SignDocument`).** Split in two:
  - [x] **S4a — port-based service** (`emission/application/sign-document.ts`): `SigningStore`
        (`load`, `markSigned`), `CertificateSource` (over `CertificateVault.open`), `CscSource` (over
        `CscVault`), `DeXmlBuilder`/`XmlSigner`/`QrGenerator`. For an `accepted` document it opens the
        active certificate for the document's environment, builds the DE (`generateInvoiceXml`), signs
        (`signInvoiceXml`, dFecFirma Asuncion), adds the QR (`addQrToSignedInvoice`: strict XSD + hash
        check) and stores `signed_xml`/`signed_at` with `accepted -> signed` in one store call. Fails
        closed (typed errors, document stays `accepted`); p12 and CSC buffers are zeroized.
  - [x] **S4b — Drizzle `SigningStore` + sources.** `load` rebuilds `InvoiceDraft` and
        `InvoiceXmlContext` (issuer profile, establishment, point, timbrado, numbering from the document row,
        receiver data and line codes from `payload`; the establishment contact is a known gap, ADR-0012
        note in `invoice-xml.ts`); `markSigned` is one tenant transaction (`UPDATE ... WHERE status =
        'accepted'`, guard 0025). `CscSource` picks the lowest slot of the tenant's CSCs for the
        environment (decision to confirm).
- [ ] **S5 — Pipeline worker.** Redis/BullMQ are not in the repo yet (no `bullmq`/`ioredis` dependency,
      no Redis service in compose or CI), so the orchestration is built first as plain application code that
      a scheduler only has to call (ADR-0003: API and worker are two entrypoints of the same code). Slices
      of <= 400 lines each:
  - [x] **S5a — `TransmissionCycle` service** (`transmission/application/transmission-cycle.ts`, ~410
        lines with its spec): per tenant, in order, sign `accepted` documents (`SignDocument`), assemble
        (`LoteAssembler`), send `pending` lotes (`SendLote`, one `dId` each), poll due lotes
        (`PollLoteResult`). Each step is bounded (batch sizes 50/20/20), each document or lote is isolated,
        failures are recorded in the report and logged with the error class only (no messages: they can
        carry hosts, paths or key material). Port `TransmissionCycleStore` finds the work.
  - [x] **S5b — Drizzle `TransmissionCycleStore`** (`drizzle-transmission-cycle-store.ts`): accepted
        documents of the tenant's current environment, `pending` lotes with their signed XML and the
        issuer RUC, due `sent` lotes, and `nextRequestId` (per tenant and environment).
  - [x] **S5c — End-to-end test** (`transmission-cycle.integration.spec.ts`): pglite + real Drizzle
        adapters + real Tips signing + `FakeSifenGateway`; `accepted -> signed -> queued -> submitted ->
        approved`, then a further run is a no-op (no resend, no requery).
  - [ ] **S5d — BullMQ infrastructure.** Add `bullmq` + `ioredis`, a Redis 7 service (compose, CI,
        `.env.example`: `REDIS_URL`), `QueueModule`, and a `TenantAwareProcessor` base (ADR-0006: the job
        carries `tenantId`, the processor opens the tenant context, `SET LOCAL` per transaction).
  - [ ] **S5e — Worker entrypoint** (`apps/api/src/worker.ts`, same code as the API, ADR-0003):
        composition of `TransmissionCycle` per tenant, a `lote-build` job per tenant (repeatable, a short
        interval) and `lote-poll`, tenant enumeration port, graceful shutdown, no overlapping runs per
        tenant (BullMQ job id per tenant). Jobs stay rebuildable: Postgres is the source of truth
        (ADR-0013).
  - [ ] **S5f — Retry hardening** (migration 0030 if a column is needed). A `0301`-rejected lote makes its
        documents eligible again at once, so a scheduler would resend every cycle: add a retry cap and
        backoff (per document attempt count and `next_attempt_at`). Also: a poisoned `pending` lote or
        permanently unsignable `accepted` document (typed errors) must not sit at the head of the batch
        forever (park with a reason after N attempts). A lote left `pending` by a crash before the claim
        is picked up again by the cycle; a stale `sending` lote becomes `unknown` in HU-E6-04.

## Decisions

- Ready = `signed` (never sent) or `queued` (in a lote that is not in process any more). `queued` is set
  by the assembler, `submitted` by the dispatch store when SIFEN answered 0300.
- 0301 (lote not enqueued, lote `rejected`): documents stay `queued`, no regression and no new
  status. A `rejected` lote is terminal and not "in process" (ADR-0007: only lotes in process
  block re-inclusion), so the documents are eligible again and the next assembly puts them in a new
  lote. The failure reason lives on the lote row (`response_code`/`response_message`).
- `unknown` (no answer) and `recovery` lotes count as in process: SIFEN may hold them (plan §8.1), so
  their CDCs are never put in another lote until HU-E6-04 resolves them.

## Establishment contact (before S4b)

- gEmis in `DE_v150.xsd` makes `dTelEmi` (tdTel, 6-15) and `dEmailE` (tEmail pattern) required and
  `dDenSuc` (1-30) optional, so they live on `tenant_establishments` (migration 0027), nullable only for
  rows created earlier. The MT PDF could not be text-extracted in this environment; the XSD is the cited
  authority (no fiscal-profile fallback: the XSD scopes them to the establishment group).
- Operator CLI: `establishment:add --phone --email --name` and `establishment:contact`.
- Signing (S4b) refuses an establishment without phone/email (typed error) and maps `dDenSuc` from
  `commercial_name`, falling back to the issuer's trade/legal name (<= 30 chars) when absent.

## S4b findings

- The accepted payload (`POST /v1/documents`) carries only the receiver RUC and bare items, but the DE needs
  the receiver's name/address/district/city (D2) and each item's code, description and unit (E7). The
  Drizzle `SigningStore.load` reads them from extra payload fields and fails with the exact missing paths
  (`SigningDataIncompleteError`) rather than inventing them: **the request schema must be extended (product
  decision, HU-E5) before real documents can be signed.**
- `CscSource` uses the lowest slot of the tenant's CSCs for the environment (approved).
