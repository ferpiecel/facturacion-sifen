# Reception: received invoices (purchases) module, port of facturaspy

- Feature: `reception` · Refs: ADR-0003, 0005, 0006, 0009, 0010, 0011, 0013, 0014, 0016, 0018 (existing); ADR-0019..0023 (proposed here) · Engram mirror: `odd/reception/tasks`
- TDD: strict (source: `strict_tdd: true` in `openspec/config.yaml`, per AGENTS.md "Pruebas"; re-resolve from B's config at the start of each session) · runner: Vitest 5.0.1 (`pnpm --filter @sifen/api test`, `@sifen/db test`, `@sifen/web test`); mode/source/runner are forwarded on every delegation.
- Delivery: strategy `ask-on-risk` (default). Forecast is far above 400 authored lines, so the user is asked ONCE for the chain strategy (`stacked-to-main` or `feature-branch-chain`) before the first commit after P0; both choices are then cached. Every PR <= 400 authored changed lines (planning heuristic; see "PR groups").
- Status: IN PROGRESS. Plan approved by the user on 2026-11-06; P0 in progress on branch `docs/reception-adrs-0019-0020` (R0.1-R0.6 done; R0.7 pending). User asked to keep working through tasks and open a single PR at a sensible breakpoint (400-line rule will require chained PRs).

## Objective

Port the features of project A (`/home/rodrigo/workspace/facturaspy`, Python/FastAPI, read-only reference) into B (`facturacion-sifen`, TypeScript, NestJS + Fastify, Drizzle, Postgres 16, BullMQ, Next.js 16) as one new hexagonal bounded module `reception`: B today only EMITS to SIFEN; it must also RECEIVE invoices issued in favor of a tenant (purchases) from (1) SIFEN XML, (2) CDC or KuDE QR link resolved through eKuatia (reCAPTCHA v2 solved by 2Captcha), (3) PDF or photo read by Anthropic vision with per-field confidence; then correction and confirmation through the API (API-first: the tenant's own software, typically an ERP, fetches, corrects and confirms; no review UI in this feature), outbound webhooks and API keys, plus a read-only portal list/detail. Everything is rewritten in B's stack; A's code is a behavioral reference and its fixtures are the golden contract.

## Problem

B has no inbound path: no aggregate for documents issued by third parties, no object storage, no vision extraction, no eKuatia consultation. A has all of that but in another stack, another tenancy model (`cuenta`, `cuenta_ruc`, own JWT login) and Spanish naming.

## Why

Tenants are already issuers (ADR-0010); letting them also capture purchases reuses RLS, API keys, webhooks, custody, audit chain and the portal, and gives the PRD's receiver-side features (HU-E9-01, future) a data foundation.

## Scope

In: module `apps/api/src/modules/reception/` (domain, application, infrastructure, `reception.module.ts`); tables with FORCE RLS; `StorageProvider` port with SeaweedFS adapter; XML ingest; vision extraction; eKuatia + 2Captcha client; async processing on BullMQ; `/v1/received-documents` API with scopes; new webhook events; OpenAPI + docs; a READ-ONLY portal list and detail in `apps/web/src/features/reception/` (status and `is_own_receiver=false` flag visible).
Out (see matrix section i): A's human login/JWT, `cuenta*` tables, ARQ, reportlab fixtures, data migration from A (none assumed), receiver events (conformidad etc.) beyond a design note, any real call to eKuatia or 2Captcha by an agent. OUT OF SCOPE by user decision (API-first): portal review inbox, review detail/edit/confirm form, items editor, confidence badges UI, and the portal upload page. Uploading, correcting and confirming are API-only in this feature.

API-first flow (product insight, user decision): the primary consumer is the tenant's own software (ERP). (1) The tenant uploads via `POST /v1/received-documents`. (2) A minimal webhook (id, status, link; for `needs_review` also the reason codes) `reception.document.confirmed` or `reception.document.needs_review` is delivered. (3) The ERP fetches the document via `GET` (extracted fields, per-field confidences, `needs_review` reasons, artifact download link). (4) A person corrects it inside the ERP. (5) The ERP syncs back via `PATCH` (API key scope `reception:write`), which can correct AND confirm in ONE call. No portal write action exists in this feature.

## Constraints (B process rules that shape this plan)

- Strict TDD: RED commit first, then GREEN; behavior-first Vitest specs next to code, e2e in `apps/api/test/` with Fastify `inject()`.
- PR <= 400 changed lines (`CLAUDE.md`); every task closes with a Conventional Commit (no AI attribution) recorded as evidence below.
- ADR process (ADR-0001): next free number is 0019 (existing 0001..0018, verified in `docs/adr/README.md`). Do not edit accepted ADRs; amend or add.
- Every table with `tenant_id`: `ENABLE` + `FORCE ROW LEVEL SECURITY`, policy `FOR ALL TO app_user` with `USING` and `WITH CHECK`, rollback script; `packages/db/test/rls-coverage.spec.ts` discovers tables from the catalog and fails otherwise. Latest migration today: `0045_mfa_enrolment.sql` (journal idx 45) so new ones start at 0046; renumber on rebase (precedent in `hu-e11-01-webhooks.md`).
- Hexagonal + dependency-cruiser (`.dependency-cruiser.cjs`, `apps/api/.dependency-cruiser.cjs`): `domain/` and `application/` free of `@nestjs/*`, `@fastify/*`, `drizzle-orm`, `bullmq`, `ioredis`, `pg`, `reflect-metadata`; `@sifen/db` and `drizzle-orm` only from `modules/*/infrastructure/`, `*.module.ts`, `cli/`, `worker/`; no cycles. New third-party SDKs (`@aws-sdk/*`, `@anthropic-ai/sdk`, wasm/pdf/qr libs) live only in `infrastructure/adapters/` behind ports (convention; add a depcruise rule in R0.6 so it is enforced).
- Dependencies pinned to exact versions in `package.json`. Money is `Decimal` (ADR-0018, `modules/emission/domain/decimal.ts`) and `numeric(23,8)`; no `number` arithmetic for amounts.
- `/v1` REST, API-key scopes, async 202 where processing is deferred (ADR-0011); `docs/api/openapi.json` regenerated (`pnpm --filter @sifen/api openapi`) or the sync test fails; new env vars validated at startup and documented in `docs/configuracion.md`; logs carry ids/counts/error names only (never XML, images, URLs, keys).
- Coverage gate 85 % per package; `pnpm verify` pre-push; CI jobs `quality-gates`, `db-postgres`, `worker-redis` (+ new storage job, R2.4).
- Hard safety rules for the agent: NEVER call eKuatia, NEVER spend 2Captcha, NEVER read `.env*`. Real captures are produced only by the human with the capture script (R6.4); tests replay committed fixtures.

## Conventions learned from B (verified by reading)

- Language: code, tables, columns, modules, routes, tests, `odd/tasks` documents in English; ADRs, `docs/`, UI copy and web route names in Spanish (e.g. `/comprobantes`).
- DB: English `snake_case` plural tables (`documents`, `webhook_endpoints`), `tenant_id uuid NOT NULL REFERENCES tenants(id)`, `uuid` PK `defaultRandom()`, `created_at`/`updated_at timestamptz`, `status varchar(32)` + CHECK (not pgEnum, except `tenantEnvironment`), `numeric(23,8)` money, Drizzle in `packages/db/src/schema.ts`, SQL in `packages/db/migrations/NNNN_name.sql` + `rollback/NNNN_name.down.sql` + `meta/*_snapshot.json`.
- API module layout: `domain/*.ts`, `application/*.ts` + `application/ports/*.port.ts`, `infrastructure/{adapters/,http/,guards/}`, `*.module.ts` with `useFactory`, `*.tokens.ts`, specs beside code (`webhooks`, `identity` are the references).
- Scopes are free-form strings (`documents:read|write`, `webhooks:read|write`), required with `@RequireScopes(...)`; tenant context via `TenantTransactionRunner` / `withTenantTransaction`; worker via `TenantAwareProcessor` (`packages/db/src/tenant-aware-processor.ts`); jobs in `apps/api/src/worker/`.
- Webhook outbox: `enqueueDocumentEvents(tx, ...)` called inside the status-changing transaction; event id = deterministic hash; `UNIQUE(endpoint_id, event_id)`; event type list is triplicated and parity-tested: `packages/db/src/schema.ts` (`WEBHOOK_EVENT_TYPES`), migrations CHECK constraints `webhook_endpoints_events_valid` / `webhook_deliveries_event_type_valid`, `apps/api/.../webhooks/domain/webhook-event.ts` (`event-types-parity.spec.ts`).
- Portal: session-guarded controllers under `portal/...` (e.g. `portal-documents.controller.ts`), web calls a same-origin proxy (`/api/portal/*`); feature code in `apps/web/src/features/<name>/`, routes in `apps/web/src/app/(portal)/<route>/page.tsx`, design system in `src/design-system/`.
- Existing reusable code found: `modules/emission/domain/cdc.ts` (`parseCdc`, `buildCdc`, `computeCdcCheckDigit`), `modules/fiscal-config/domain/ruc.ts` (`parseRuc`, `computeRucCheckDigit`), `modules/emission/domain/decimal.ts`, `packages/sifen-xsd` (`validate-xml.ts`, libxml2-wasm 0.7.2), `modules/custody` (envelope encryption), `jsqr 1.4.0` and `pdfjs-dist 6.3.289` already in `apps/api` devDependencies, `fast-check` 4.10.2.
- Cross-module imports between module `domain/` folders are not forbidden by any current depcruise rule (UNVERIFIED beyond reading the rule names); decision in ADR-0019: import the pure CDC/RUC/Decimal helpers from `emission`/`fiscal-config` domain through their public files, or hoist them to a shared kernel; default = import as is, no hoist.

## Findings: prior mapping vs real code (A)

1. A `POST /v1/invoices` is SYNCHRONOUS (extraction/eKuatia run inside the request; returns 201 created or 200 deduped). There is no 202 in A; `app/api/routes/facturas.py:109`. The async 202 flow in B is a design change, not a port.
2. State `extrayendo` exists in `EstadoFactura` but is never assigned anywhere in A (`git grep EXTRAYENDO`). Events `invoice.needs_review`, `invoice.extraction_failed`, `invoice.deleted` are declared in `EventoWebhook` but never emitted; no DELETE route for invoices exists. Only `invoice.confirmed` and `invoice.updated` fire.
3. A has an extra state `emitida` (confirmada -> emitida once the webhook is enqueued). Not in the requested machine; DROPPED (B outbox makes it redundant).
4. A scopes are `invoices:read`, `invoices:write`, `webhooks:manage` (not per-resource read/write for webhooks).
5. A's XML parser supports only "Factura electrónica" (`app/infrastructure/sifen/parser.py:30`, maps `dDesTiDE` text); NC/ND/AFE raise `TipoComprobanteXmlError`. `TipoDocumento` enum is wider than what is ingestible.
6. `es_receptor_propio` is only a boolean flag in A; mismatch does not reject the document. DECIDED (Q3, user): B stores such documents with `is_own_receiver=false` and does NOT emit any reception webhook event for them (no reject, no forced review).
7. A's eKuatia client contract was never verified live (docstring in `app/infrastructure/ekuatia/client.py`); the committed captures (`requests.json`) are the only ground truth. Dedupe-before-solve is implemented in A (`ingesta_cdc.py`).
8. `UMBRAL_AUTO_CONFIRMAR = 0.85` is duplicated at `ingesta_extraccion.py:37` and `reprocess.py:31` (confirmed). Also A auto-confirms XML at confidence 1.0 and validates arithmetic (`validacion_factura.py`, tolerance 1.00 Gs); RUC modulo-11 and CDC check digit are deliberately NOT validated in A (B has both: `computeRucCheckDigit`, `computeCdcCheckDigit`).
9. A tests: 19 files confirmed (8 integration, 11 unit incl. `test_sifen_parser`, `test_validacion_factura`, `test_webhook_backoff`, `test_webhook_signing`). A frontend: 28 files under `frontend/src`, pages total 1070 lines; `FacturasListPage.tsx` is untracked WIP in A's working tree (also modified `App.tsx`, `Layout.tsx`, `RevisionDetailPage.tsx`).
10. A webhooks also have endpoint auto-pause after 10 consecutive failures (`tasks.py`), `/test` and `/reactivate` routes and `X-Fpy-*` headers; B has its own signature scheme (`Sifen-Signature`). Parity of pause/test in B is UNVERIFIED and out of scope here.
11. contahelper SeaweedFS reference uses `chrislusf/seaweedfs:latest` and NO S3 identities (unauthenticated) in both compose and CI; this plan pins the tag and configures identities.
12. B's portal has no API-keys/webhooks settings pages today (only home, comprobantes, login, tenant picker; UNVERIFIED for anything outside `apps/web/src/app`), so A's "Ajustes" page has no B counterpart to extend.

## 1. Mapping matrix

Actions: REUSE (exists in B, use as is), PORT (rewrite A logic in TS), NEW (no A equivalent), REPLACE (A concept replaced by a B one), DROP (not ported). A paths are under `/home/rodrigo/workspace/facturaspy`; B targets under `/home/rodrigo/workspace/facturacion-sifen`. `RM` = `apps/api/src/modules/reception`.

### (a) Entities, tables, columns, enums

Naming rule: B uses English `snake_case` for tables and columns; A is Spanish. Proposed names below.

| A artifact | B target | Action | Notes (A source -> B target) |
|---|---|---|---|
| `factura` table (~45 cols) | `received_documents` | PORT | `app/infrastructure/db/models/factura.py` -> `packages/db/src/schema.ts` + migration 0046+. Own aggregate; never reuse `documents` or `lotes`. |
| `factura.origen` (OrigenFactura xml_sifen, cdc_ekuatia, pdf, foto, manual) | `source varchar(16)` CHECK `sifen_xml`,`ekuatia_cdc`,`pdf`,`photo` | PORT | `manual` has no creator in A -> DROP value (add later with a route). |
| `factura.tipo_documento` (TipoDocumento text enum) | `document_type smallint` (iTiDE code, 1 FE, 4 AFE, 5 NCE, 6 NDE, 7 NRE) | REPLACE | B stores iTiDE like `documents.document_type`; A maps `dDesTiDE` text. MVP ingests FE only (as A); other codes gated by fixtures (R3.2). `boleta_resimple`, `despacho_importacion` have no iTiDE in B: DROP. |
| `factura.estado` (EstadoFactura) | `status varchar(32)` CHECK `received`,`extracting`,`extracted`,`needs_review`,`extraction_failed`,`confirmed` | PORT | Requested Spanish names `recibida/extrayendo/extraida/requiere_revision/error_extraccion/confirmada` map 1:1 to these English values (see h). `emitida` DROP. |
| `factura.version` | `version integer` (optimistic lock) | PORT | Incremented on PATCH/reprocess; PATCH takes `If-Match`/`version` (decision R4.4). |
| `cdc`, `timbrado`, `establecimiento`, `punto_expedicion`, `nro_documento`, `serie` | `cdc char(44)`, `timbrado varchar(8)`, `establishment_code varchar(3)`, `expedition_point_code varchar(3)`, `document_number varchar(7)`, `series varchar(2)` | PORT | Strings (received docs have no local FK). `UNIQUE(tenant_id, environment?, cdc)`: received CDC is global per SIFEN so `UNIQUE(tenant_id, cdc)` (A `uq_factura_tenant_cdc`). Partial unique, CDC nullable for paper. |
| `uq_factura_tenant_numero` (tenant, ruc_emisor, timbrado, nro_documento) | `UNIQUE(tenant_id, issuer_ruc_base, timbrado, document_number)` partial where all not null | PORT | Paper dedupe without CDC. |
| emisor block (`ruc_emisor`, `dv_emisor`, `razon_social_emisor`, `nombre_fantasia_emisor`, `direccion_emisor`, `actividad_economica_emisor`) | `issuer_ruc_base varchar(8)`, `issuer_ruc_dv smallint`, `issuer_legal_name`, `issuer_trade_name`, `issuer_address`, `issuer_economic_activity` | PORT | Same RUC split as `tenant_fiscal_profiles` (`ruc_base`, `ruc_dv`). A stores whole RUC string; B splits using `parseRuc`. |
| receptor block (`ruc_receptor`, `dv_receptor`, `razon_social_receptor`, `tipo_receptor`) | `receiver_ruc_base`, `receiver_ruc_dv`, `receiver_legal_name`, `receiver_type smallint?` | PORT | `tipo_receptor` is None in A when unconfirmed (parser docstring); keep nullable. Receiver type codes UNVERIFIED against MT v150; confirm in R3.2. |
| `es_receptor_propio` | `is_own_receiver boolean` | PORT | Derived at ingest from `tenant_fiscal_profiles` (see `cuenta_ruc` row). Policy (Q3, decided): store with `false`, never emit webhooks for it; no reject. |
| dates (`fecha_emision`, `fecha_vencimiento`, `fecha_pago`) | `issued_on date`, `due_on date`, `paid_on date` | PORT | `documents.issued_at` is timestamptz for emitted; received XML carries `dFecEmi` with time: store `issued_at timestamptz` and keep `due_on`/`paid_on` dates. |
| `condicion`, `plazo_credito_dias`, `medio_pago` (CondicionPago contado/credito) | `payment_condition varchar(8)` CHECK `cash`,`credit`; `credit_term_days`; `payment_method` | PORT | Verify SIFEN codes `iCondOpe` in R3.2. |
| `moneda`, `tipo_cambio`, `total_pyg` | `currency char(3) default 'PYG'`, `exchange_rate numeric(23,8)`, `total_pyg numeric(23,8)` | PORT | Multi-currency math is out of scope (ADR-0018 defers it); store as read. |
| totals (`total_exenta`, `total_exonerada`, `gravada_5`, `gravada_10`, `iva_5`, `iva_10`, `total_iva`, `total_descuento`, `total_general`) | `total_exempt`, `total_zero_rated`, `taxable_5`, `taxable_10`, `vat_5`, `vat_10`, `total_vat`, `total_discount`, `total_amount` all `numeric(23,8)` | PORT | A `Decimal`, no precision; B `numeric(23,8)` + `Decimal` VO. `total_exonerada` = exonerado (verify term in MT). |
| `estado_sifen` (aprobado, rechazado, cancelado, inutilizado, na), `fecha_autorizacion`, `nro_protocolo_autorizacion` | `sifen_status varchar(16)` default `unknown`, `sifen_authorized_at`, `sifen_protocol_number` | PORT | A always sets `na` for non-SIFEN origins. Cancellation/void of received docs is future work. |
| `confianza_global` | `confidence_overall numeric(4,3)` | PORT | 0..1; null for XML origins? A stores 1.0 for XML implicitly via no per-field rows; B stores 1.000 explicitly. |
| `requiere_revision` | `needs_review boolean` | PORT | Redundant with status; kept as index-friendly flag and parity check in domain. |
| `artefacto_id` FK | `artifact_id uuid` composite FK `(tenant_id, artifact_id)` | PORT | Composite tenant FK as in `webhook_deliveries` (S2b in `hu-e11-01-webhooks.md`). |
| `datos_crudos` JSON | `raw_data jsonb` | PORT | Raw parsed rDE or raw LLM output; never logged. |
| `created_at`, `updated_at`, `tenant_id` mixins | same | REUSE | B defaults. |
| new columns | `idempotency_key`, `request_hash`, `extraction_attempts`, `extraction_error_code`, `confirmed_at`, `confirmed_by` (portal user id or API key id) | NEW | Idempotency like `documents` (HU-E5-02); error code is a plain code, never free text. |
| `factura_item` | `received_document_items` | PORT | `models/factura.py:127`. Own `tenant_id` + composite FK to `received_documents` (A comment explains why). Columns: `position`, `description`, `product_code`, `quantity`, `unit_of_measure`, `unit_price`, `discount`, `subtotal`, `vat_rate smallint`, `taxable_base`, `vat_amount`. `quantity` max 10 int + 8 dec (ADR-0018). |
| `factura_campo_confianza` | `received_document_field_confidences` | PORT | Columns `field_name`, `confidence numeric(4,3)`, `extracted_value`, `corrected_value`, `corrected_by`, `corrected_at`; `UNIQUE(received_document_id, field_name)`. Field set (8): ruc_emisor, razon_social_emisor, fecha_emision, nro_documento, ruc_receptor, condicion, totales, items -> English `issuer_ruc`, `issuer_legal_name`, `issued_on`, `document_number`, `receiver_ruc`, `payment_condition`, `totals`, `items`. |
| `artefacto` | `received_artifacts` | PORT | `storage_key unique`, `content_type`, `sha256` (index, `UNIQUE(tenant_id, sha256)`), `size_bytes`, `original_name`, `page_count`. Object lives in SeaweedFS, never in DB. Key scheme `<source>/<tenant_id>/<sha256|cdc>.<ext>` (A) kept, prefixed by environment. |
| `cuenta` | `tenants` (+ `tenant_fiscal_profiles`) | REPLACE | `models/cuenta.py`. Tenant = account. `email`, `password_hash`, `activa` DROP (B portal users/auth). `nombre` = tenant name. |
| `cuenta.ruc_propio` | `tenant_fiscal_profiles.ruc_base` + `ruc_dv` | REPLACE | `packages/db/src/schema.ts:327`. Receiver validation reads this row (ADR-0010: tenant is issuer with RUC). |
| `cuenta_ruc` (extra RUCs) | none (DROP table) | DROP | One fiscal profile per tenant in B. Multi-RUC per tenant: open question Q4; default = unsupported, a second RUC is a second tenant. |
| `api_key` | `apiKeys` (`schema.ts:98`) | REUSE | Hash-only storage, `resolve_api_key` SECURITY DEFINER; scopes added, no schema change (free-form). A `app/infrastructure/security/api_key.py` DROP. |
| `webhook_endpoint` | `webhookEndpoints` (`schema.ts:746`) | REUSE | Sealed secret via custody; A's plain `secret` column DROP. Events filter CHECK must learn the new types (R4.5). |
| `webhook_delivery` | `webhookDeliveries` (`schema.ts:795`) | REUSE | Retry/DLQ/history exist; A `estado` pendiente/ok/error/agotado ~ B `pending/.../dead`. CHECK on `event_type` learns the new types. |
| `EstadoEntregaWebhook` | B delivery statuses | REUSE | no code. |
| `ApiKeyScope` invoices:read, invoices:write, webhooks:manage | `reception:read`, `reception:write` (+ existing `webhooks:read|write`) | REPLACE | R4.1. `webhooks:manage` DROP (B already splits read/write). |
| `EventoWebhook` (5 values) | `reception.document.confirmed`, `.needs_review`, `.extraction_failed`, `.updated` | PORT | Naming per B dotted style (`document.approved`). A emits only confirmed/updated; B emits these four. `.deleted` OUT OF SCOPE (Q5b, user): no delete in this feature. |

### (b) Processes and use cases

| A artifact | B target | Action | Notes |
|---|---|---|---|
| `application/facturas/ingesta_xml.py` (`ingresar_factura_desde_xml`, dedupe by CDC, store artifact first, confidence 1.0) | `RM/application/ingest-sifen-xml.ts` (use case) + ports `received-document-repository.port.ts`, `storage-provider.port.ts` | PORT | R3.3. Store artifact BEFORE parsing (A invariant: a parser bug never loses the upload). |
| `infrastructure/sifen/parser.py` (`parse_cabecera`, `parse_items`, 253 lines) | `RM/application/ports/sifen-xml-parser.port.ts` + `RM/infrastructure/adapters/sifen-xml-parser.adapter.ts` | PORT | R3.2. Parser library choice is a spike (libxml2-wasm already used by `packages/sifen-xsd` vs a pure JS parser); must be XXE-safe. Namespace `http://ekuatia.set.gov.py/sifen/xsd`. |
| `application/facturas/ingesta_cdc.py` (`ingresar_factura_por_cdc`, dedupe before solving) | `RM/application/ingest-from-cdc.ts` + job `reception-ekuatia-lookup` | PORT | R6.3. Async 202 in B (A was inline). Dedupe before spending a solve. |
| `domain/cdc.py` (`extraer_cdc`: 44 digits or `?Id=` in QR URL) | `RM/domain/cdc-reference.ts` wrapping `emission/domain/cdc.ts` `parseCdc` | PORT+REUSE | Add check-digit validation (B has it, A deliberately lacks it). |
| `application/facturas/ingesta_extraccion.py` (PDF/photo, hash dedupe, LLM, validations, threshold) | `RM/application/extract-received-document.ts` + BullMQ processor `apps/api/src/worker/reception-extraction.processor.ts` | PORT | R5.6. Synchronous in A, async worker in B. `UMBRAL_AUTO_CONFIRMAR` centralized in `RM/domain/confidence-policy.ts`, value from config (R5.1). |
| `infrastructure/llm/{base,anthropic_llm,factory,prompts}.py` | `RM/application/ports/extraction-llm.port.ts`, `RM/infrastructure/adapters/anthropic-extraction-llm.adapter.ts`, `RM/domain/extraction-prompt.ts` + zod schema | PORT | R5.2/R5.3. Prompt caching on system prompt, JSON-schema output, fallback model once, refusal handling, Decimal-safe parsing (A uses `parse_float=Decimal`; in TS parse amounts as strings). |
| `infrastructure/extraction/pdf.py` (`extraer_texto`, `rasterizar_paginas` dpi 200 max 5, `contar_paginas`) | `RM/application/ports/pdf-renderer.port.ts` + adapter | PORT | R5.4 (library spike). |
| `infrastructure/extraction/qr.py` (`decodificar_cdc_de_imagen`) | `RM/application/ports/qr-decoder.port.ts` + adapter | PORT | R5.5. A makes pyzbar optional (`ImportError` fallback); decide in ADR-0021 whether QR is mandatory. |
| `domain/validacion_factura.py` (`validar_totales`, `validar_formato_numero_documento`, `todas_ok`) | `RM/domain/received-document-validation.ts` | PORT | R3.1. Rewritten on `Decimal`; tolerance 1.00 Gs kept configurable; plus NEW RUC DV and CDC DV checks. |
| `application/facturas/receptor.py` (`es_receptor_propio`) | `RM/application/ports/tenant-fiscal-identity.port.ts` + Drizzle adapter reading `tenant_fiscal_profiles` | REPLACE | R3.1/R3.3. Compare base only (A `ruc_base`), then DV. |
| `application/facturas/correccion.py` (PATCH, versioning, confirm, webhook only on confirm/update) | `RM/application/correct-received-document.ts` | PORT | R5.7. Audit via B audit hash chain (new) plus field-level `corrected_*` columns (A). |
| `application/facturas/reprocess.py` | `RM/application/reprocess-received-document.ts` | PORT | R5.8. Re-runs on stored artifact; 202 + job in B. |
| `application/facturas/consulta.py` (keyset list, `updated_since`, filters) | `RM/application/list-received-documents.ts` + `RM/infrastructure/drizzle-received-document-query.ts` | PORT | R4.3. Keyset cursor like B's document query (`document-query.ts`). |
| `application/facturas/presentacion.py` (`factura_to_schema`) | `RM/infrastructure/http/received-document.presenter.ts` | PORT | Response DTO; amounts as decimal strings. |
| `application/facturas/emision.py` (`emitir_factura`, `emitir_actualizacion`, estado emitida) | `RM/infrastructure/enqueue-reception-events.ts` (outbox helper in the status transaction) | REPLACE | R4.5. Same pattern as `enqueue-document-events.ts`; payload minimal + link (B convention), not A's full invoice body (Q5). |
| `application/webhooks/use_cases.py`, `infrastructure/queue/tasks.py` (`enviar_webhook`), `webhooks/signing.py`, `domain/webhook_backoff.py` | `modules/webhooks/*` | REUSE | No port. Only the event list changes (R4.5). |
| `application/auth/*`, `application/cuentas/use_cases.py`, `security/{jwt,password,kms,encryption}.py` | `modules/identity`, `modules/custody`, portal auth | REPLACE | Human login NOT ported. Encryption/KMS = B custody (ADR-0009). |
| `infrastructure/captcha/{base,twocaptcha}.py` | `RM/application/ports/captcha-solver.port.ts` + adapter | PORT | R6.1. |
| `infrastructure/ekuatia/client.py` | `RM/application/ports/ekuatia-client.port.ts` + adapter | PORT | R6.2. Site key and endpoints from A (`EKUATIA_RECAPTCHA_SITEKEY`, `POST /docs/documento-electronico`, `GET /docs/documento-electronico-xml/{cdc}`) are unverified live; keep configurable. |
| `infrastructure/storage/{base,s3}.py` (`upload/download/delete/exists/presigned_url(900 s)/ping`) | `RM/application/ports/storage-provider.port.ts` + `S3StorageProvider` adapter | PORT | R2.1/R2.2. Generic enough to host KuDE later; ADR-0020. |
| `infrastructure/queue/{pool,redis,tasks,worker}.py` (ARQ) | BullMQ queues in `apps/api/src/worker/` | REPLACE | ADR-0013 pattern (`TenantAwareProcessor`, repeatable reconcile). |
| `infrastructure/db/tenant_context.py` (SET LOCAL app.tenant_id) | `withTenantTransaction` / `TenantTransactionRunner` | REUSE | no code. |
| `infrastructure/logging.py`, `api/middleware/request_logging.py` | B logger/bootstrap | REUSE | Logs carry ids only. |

### (c) API routes

A prefix `/v1/invoices`; B prefix `/v1/received-documents` (English resource name, kebab-case plural).

| A route | B route | Scope | Action | Notes |
|---|---|---|---|---|
| `POST /v1/invoices` (multipart `file`, raw xml/pdf/image body, JSON `{xml}` or `{cdc}`; 201/200) | `POST /v1/received-documents` | `reception:write` | PORT | Same input forms. Response (Q6 DECIDED by user: asynchronous): ALL sources (XML, PDF, photo, CDC) = 202 `received` + `Location`, processed by the BullMQ worker; a dedupe hit (same CDC/sha256) returns 200 with the existing document. No inline processing in the request. Optional `Idempotency-Key` (natural idempotency by CDC/sha256; Q6). 15 MiB cap (A `TAMANO_MAXIMO_ARCHIVO`), magic-byte sniffing (NEW), needs `@fastify/multipart` (NEW dep, pin). RFC 7807 errors as A `ProblemDetailException` mapped to B's error style (UNVERIFIED: read `document-http-errors.ts` in R4.2). |
| `GET /v1/invoices` (cursor, limit<=200, `updated_since`, `estado`, `ruc_emisor`, `fecha_emision_desde/hasta`) | `GET /v1/received-documents` | `reception:read` | PORT | Params -> `cursor`, `limit`, `updated_since`, `status`, `issuer_ruc`, `issued_from`, `issued_to`. |
| `GET /v1/invoices/{id}` | `GET /v1/received-documents/{id}` | `reception:read` | PORT | includes items + field confidences. |
| `PATCH /v1/invoices/{id}` (corrections + `confirmar`) | `PATCH /v1/received-documents/{id}` | `reception:write` | PORT | API-first contract (the ERP is the corrector). Requirements, field names NOT final ("shape to be fixed in R4.3/R4.4 RED tests"): single call "correct + confirm" (optional `confirm: true`); fields list `CAMPOS_CORREGIBLES` (14) + items; optimistic version check (409 on conflict); revalidation on confirm; idempotent by version (replaying the same version/payload does not duplicate effects). Companion `GET /v1/received-documents/{id}` must return extracted fields, per-field confidences, `needs_review` reasons and the artifact download link so an ERP can render its own review. |
| `POST /v1/invoices/{id}/reprocess` | `POST /v1/received-documents/{id}/reprocess` | `reception:write` | PORT | 202 in B (A sync). 409 `artifact_not_available`. |
| `GET /v1/invoices/{id}/artifact` (stream) | `GET /v1/received-documents/{id}/artifact` | `reception:read` | PORT | Streams from StorageProvider, `Content-Disposition: inline`. |
| `GET /v1/invoices/{id}/artifact/url` (presigned 900 s) | `GET /v1/received-documents/{id}/artifact/url` | `reception:read` | PORT | `{url, expires_in_seconds}`; requires `-s3.externalUrl` host (ADR-0020). |
| none | `DELETE /v1/received-documents/{id}` | `reception:write` | OUT OF SCOPE | Deferred (Q5b, user): fiscal documents are retained; no route, no `reception.document.deleted`. |
| `POST/GET/DELETE /v1/api-keys` | existing identity/API-key management | n/a | REUSE | `app/api/routes/api_keys.py` DROP. |
| `/v1/webhooks*` (CRUD, rotate-secret, reactivate, test, deliveries, replay) | existing `webhooks` controllers | n/a | REUSE | `app/api/routes/webhooks.py` DROP. |
| `POST /auth/login`, `/auth/refresh` | portal auth (`modules/identity`) | n/a | REPLACE | not ported. |
| `GET /health` | existing `modules/health` | n/a | REUSE | add storage ping (R2.5, optional). |
| none (A frontend called the same `/v1` API with JWT) | `GET /portal/received-documents` (list) and `GET /portal/received-documents/{id}` (detail) | portal session | NEW | R7.1; READ-ONLY. B's portal talks to session-guarded `portal/*`, not `/v1` with keys. Same read use cases, different controller + guard. Portal `POST`/`PATCH` endpoints are OUT OF SCOPE (API-first; uploads, corrections and confirmations go through `/v1`). |

### (d) Infrastructure and libraries

| Python (A) | TypeScript (B) | Action | Notes |
|---|---|---|---|
| fastapi/uvicorn/pydantic | NestJS 12.1.0 + Fastify + zod 4.6.5 | REPLACE | already in B. |
| sqlalchemy/asyncpg/alembic | Drizzle 0.45.3 + SQL migrations | REPLACE | already in B. |
| arq + redis | BullMQ 6.3.11 + ioredis 6.0.0 | REPLACE | already in B. |
| structlog | B logger | REUSE | |
| python-jose, bcrypt | portal auth, `@node-rs/argon2` | REPLACE | not ported. |
| cryptography AES-GCM/KMS | `modules/custody` | REUSE | |
| boto3 | `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (`forcePathStyle: true`) | PORT | NEW deps, pin exact (resolve latest stable at R2.2). |
| anthropic | `@anthropic-ai/sdk` | PORT | NEW dep, pin. Use the `claude-api` skill when implementing R5.3 (model IDs, structured outputs, caching). |
| pypdfium2 + pillow | spike: candidates `pdfjs-dist` (already 6.3.289, text OK; raster needs a canvas), pdfium wasm package, `mupdf` wasm | PORT | R5.4. Check license (mupdf.js is AGPL: UNVERIFIED, verify before choosing), size, Node 22 support, cold start. Choose, justify in ADR-0021, pin. |
| pyzbar (+ libzbar0 system lib) | spike: `jsqr` 1.4.0 (already devDep; needs RGBA pixels), `zxing-wasm`; plus an image decoder (`sharp`, `pngjs`/`jpeg-js`) | PORT | R5.5. Avoid system binaries. |
| 2captcha-python (`AsyncTwoCaptcha`) | spike: a maintained TS/JS 2Captcha client vs thin Node `fetch`-based client against the 2Captcha HTTP API (createTask/getTaskResult for RecaptchaV2TaskProxyless) | PORT | R6.1. Default: thin client behind the port (fewer deps, testable with a local fake server). Verify API shape against 2Captcha docs at implementation (UNVERIFIED here). |
| httpx | Node 22 `fetch`/undici | REPLACE | tests use a local HTTP server or undici `MockAgent`. |
| minio/contahelper SeaweedFS | SeaweedFS (S3 API) pinned image | PORT | R2.3/R2.4; contahelper refs: `docker-compose.yml` (`seaweedfs`, `seaweedfs-init`), `.github/workflows/ci.yml` (`docker run chrislusf/seaweedfs server -dir=/data -s3 -s3.port=9000`), `app/infrastructure/storage/s3.py`. |
| python-multipart | `@fastify/multipart` | NEW | pin; size limits enforced at stream level. |
| lxml/ElementTree | XXE-safe parser (spike R3.2) | PORT | A uses stdlib `xml.etree` (no DTD protection concerns documented). |
| reportlab, qrcode (A test fixture generators) | committed fixtures; B has `pdfkit 0.20.2`, `qrcode 1.5.4` for generators if needed | REPLACE | R5.x tests may generate PDFs/QRs with B's existing deps; no new deps. |
| pytest, pytest-asyncio | Vitest 5.0.1 | REPLACE | |
| ruff, mypy | ESLint, tsc 6.0.3, Prettier | REPLACE | |
| Alembic RLS migrations (`8f3c1a9d2b4e`, `5c1e8a4f9b21`, `3a7c9e1f5d2b` non-superuser role) | `0001_rls.sql` pattern, `app_login`/`app_user` roles | REUSE | |

### (e) Configuration (names only)

| A env var | B env var (proposed) | Action | Notes |
|---|---|---|---|
| `DATABASE_URL`, `DATABASE_URL_MIGRATIONS`, `APP_DB_PASSWORD`, `REDIS_URL`, `LOG_LEVEL`, `APP_ENV`, `CORS_ALLOW_ORIGINS` | existing B vars (`DATABASE_URL`, `REDIS_URL`, `NODE_ENV`, `PORTAL_ORIGIN`...) | REUSE | see `docs/configuracion.md`. |
| `JWT_SECRET_KEY`, `JWT_ALGORITHM`, `JWT_ACCESS_TOKEN_EXPIRE_MINUTES`, `JWT_REFRESH_TOKEN_EXPIRE_DAYS` | none | DROP | |
| `KMS_PROVIDER`, `KMS_ENV_KEY` | `KMS_LOCAL_MASTER_KEY` | REUSE | |
| `STORAGE_ENDPOINT_URL`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_BUCKET`, `STORAGE_REGION`, `STORAGE_USE_PATH_STYLE` | `STORAGE_ENDPOINT_URL`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, `STORAGE_BUCKET`, `STORAGE_REGION`, `STORAGE_FORCE_PATH_STYLE`, `STORAGE_PUBLIC_ENDPOINT_URL` | PORT | New, fail-fast outside `development`/`test`; no permissive default credentials in production (AGENTS "Configuración fail-fast"). `STORAGE_PUBLIC_ENDPOINT_URL` = host used to sign presigned URLs (matches `-s3.externalUrl`). |
| `LLM_PROVIDER` | none | DROP | single provider behind the port; reintroduce only with a 2nd adapter. |
| `ANTHROPIC_API_KEY` | `ANTHROPIC_API_KEY` | PORT | optional at boot; reception extraction disabled (503 `extraction_unavailable`) if absent. |
| `LLM_EXTRACTION_MODEL` (A default `claude-sonnet-5`), `LLM_FALLBACK_MODEL` (A default `claude-haiku-4-5-20251001`) | `RECEPTION_EXTRACTION_MODEL`, `RECEPTION_EXTRACTION_FALLBACK_MODEL` | PORT | No hardcoded model IDs in code; defaults documented, verified against the `claude-api` skill at R5.3. |
| `TWOCAPTCHA_API_KEY` | `TWOCAPTCHA_API_KEY` | PORT | optional; eKuatia lookup returns 503 `ekuatia_unavailable` if absent (A bug fixed in its last commit: 500 when key missing). |
| hardcoded `UMBRAL_AUTO_CONFIRMAR=0.85`, `TAMANO_MAXIMO_ARCHIVO` 15 MiB, `MAX_PAGINAS_RASTERIZADAS` 5, dpi 200, validation tolerance 1.00 | `RECEPTION_AUTO_CONFIRM_THRESHOLD`, `RECEPTION_MAX_UPLOAD_BYTES`, `RECEPTION_MAX_PDF_PAGES`, `RECEPTION_PDF_DPI`, `RECEPTION_TOTALS_TOLERANCE` | NEW | Configurable per ADR rule "todo valor en disputa es configurable". |
| none | `RECEPTION_EKUATIA_ENABLED`, `RECEPTION_EKUATIA_DAILY_SOLVE_CAP`, `RECEPTION_EXTRACTION_DAILY_CAP` | NEW | kill switch and spend guards (risks R-3, R-4). |

### (f) Tests and fixtures

| A test / fixture | B Vitest spec (beside code unless noted) | Action | Notes |
|---|---|---|---|
| `tests/unit/test_cdc.py` | `RM/domain/cdc-reference.spec.ts` | PORT | + check-digit cases (NEW). |
| `tests/unit/test_validacion_factura.py` | `RM/domain/received-document-validation.spec.ts` | PORT | + `fast-check` properties on totals (already a devDep). |
| `tests/unit/test_sifen_parser.py` | `RM/infrastructure/adapters/sifen-xml-parser.adapter.spec.ts` | PORT | Golden: `tests/fixtures/sifen/{factura_contado,factura_servicio_digital}/documento.xml` copied verbatim. |
| `tests/unit/test_pdf_extraction.py` | `.../pdf-renderer.adapter.spec.ts` | PORT | PDFs generated with B's `pdfkit` or committed fixtures. |
| `tests/unit/test_qr.py` | `.../qr-decoder.adapter.spec.ts` | PORT | QR images from B's `qrcode`. |
| `tests/unit/test_llm_extraccion.py` | `.../anthropic-extraction-llm.adapter.spec.ts` + `RM/domain/extraction-prompt.spec.ts` | PORT | SDK mocked; recorded response JSON fixtures; never a real API call in CI. |
| `tests/unit/test_captcha.py` | `.../two-captcha-solver.adapter.spec.ts` | PORT | local fake HTTP server. |
| `tests/unit/test_ekuatia_client.py` | `.../ekuatia-http-client.adapter.spec.ts` | PORT | replays `requests.json`/`documento.xml` from `tests/fixtures/ekuatia/v2026-Q3/{success,success_pago_credito,servicio_digital}` + `_consulta_page/consulta_page.html` verbatim as contract. |
| `tests/unit/test_webhook_signing.py`, `test_webhook_backoff.py`, `test_jwt.py` | none | DROP | B has `webhook-signature.spec.ts`, `webhook-backoff.spec.ts`; no JWT. |
| `tests/integration/test_ingesta_xml.py`, `test_ingesta_cdc.py`, `test_ingesta_extraccion.py` | `apps/api/test/reception-ingest.e2e.spec.ts` (+ use-case specs with fakes) | PORT | Postgres via the project's e2e harness (UNVERIFIED which harness `documents.e2e.spec.ts` uses: read in R4.7). |
| `tests/integration/test_rls.py` | `packages/db/test/rls-coverage.spec.ts` (automatic) + `packages/db/test/isolation.spec.ts` additions + `reception.e2e` cross-tenant case | PORT | A real-role escape tests run only in job `db-postgres`. |
| `tests/integration/test_api_keys.py`, `test_auth.py`, `test_health.py` | existing B suites | DROP | |
| `tests/integration/test_webhooks.py` | `event-types-parity.spec.ts` update + `webhooks.e2e.spec.ts` reception event case | PORT (partial) | only the new-events slice. |
| `tests/fixtures/ekuatia/README.md`, `scripts/capture_ekuatia.py`, `scripts/anonymize_fixtures.py`, `scripts/_capture_common.py` | `apps/api/test/fixtures/reception/` + `apps/api/scripts/reception/capture-ekuatia.ts`, `anonymize-fixtures.ts` (R6.4) | PORT | Human-run only; refuses to run in CI. |
| new | storage integration vs real SeaweedFS incl. presigned URL GET over HTTP (R2.4); architecture fixture for new depcruise rule (R0.6); migration/RLS tests (R1.x) | NEW | |

### (g) Frontend (A `frontend/src`, React 19 + Vite + Tailwind 4 + TanStack Query) -> `apps/web/src/features/reception/`

B is Next.js 16 with its own design system and same-origin proxy; A's components are references, not copied. API-first decision (user): the portal gets only a READ-ONLY list and detail of received documents; review inbox, review/edit/confirm form, items editor, confidence badges and the upload page are DROPPED (out of scope, see Risks).

| A page/component | B target | Action | Notes |
|---|---|---|---|
| `pages/LoginPage.tsx`, `auth/*`, `api/auth.ts`, `api/tokenStorage.ts` | existing `features/auth` | REPLACE | not ported. |
| `pages/SubirPage.tsx` | none | DROP (out of scope, API-first) | Upload is API-only (`POST /v1/received-documents`). |
| `pages/RevisionListPage.tsx` | none | DROP (out of scope, API-first) | The ERP polls/gets webhooks for `needs_review`; the read-only list can filter by status. |
| `pages/RevisionDetailPage.tsx` (+ modified WIP) | `features/reception/received-detail.tsx` at `.../recibidos/[id]/page.tsx` | PORT (read-only only) | Status, extracted fields, `is_own_receiver=false` flag, read-only items and artifact link. No edit, no confirm, no items editor, no confidence badges UI. |
| `components/ArtefactoViewer.tsx` | `features/reception/artifact-viewer.tsx` | PORT (read-only) | Viewer of the stored artifact via presigned link; PDF/image/XML. |
| `pages/FacturasListPage.tsx` (untracked WIP in A) | `features/reception/received-list.tsx` at `.../recibidos/page.tsx` | PORT (read-only) | Status filter; shows `is_own_receiver=false` flag. |
| `pages/AjustesPage.tsx`, `api/apiKeys.ts`, `api/webhooks.ts` | none yet | DROP (deferred, R7.7) | B portal has no API-key/webhook pages (see Finding 12). |
| `components/ui/{Badge,Button,Card,Dialog,Input,Skeleton}.tsx` | `src/design-system/components/*` (`StatusBadge`, `MoneyPyg`, `CdcDisplay` exist) | REUSE | add only missing pieces to the design system. |
| `api/client.ts`, `api/facturas.ts`, `api/types.ts` | `features/reception/reception-client.ts` (pattern of `documents-client.ts`, `portal-http`) | PORT | |
| UI copy (Spanish) | Spanish copy in B tone; route name `recibidos` (Q7) | PORT | |

### (h) State machine and events

| A | B | Notes |
|---|---|---|
| `recibida` | `received` | upload stored (artifact persisted first) |
| `extrayendo` (declared, never set) | `extracting` | really used in B (async worker claims it) |
| `extraida` (declared, never set) | `extracted` | transient: extraction result persisted; policy decides next |
| `requiere_revision` | `needs_review` | confidence below threshold, validations failed, or missing mandatory fields (A rule in `ingesta_extraccion.py:155`). Receiver mismatch does NOT force this state (Q3): the document follows the normal rules but is flagged `is_own_receiver=false` and is webhook-silent |
| `error_extraccion` | `extraction_failed` | LLM/eKuatia failure after retries; retryable via reprocess |
| `confirmada` | `confirmed` | auto (XML, or confidence >= threshold and valid) or human confirm |
| `emitida` | none | DROP |

Transitions: `received -> extracting -> extracted -> (confirmed | needs_review)`, `extracting -> extraction_failed`, `needs_review -> confirmed` (PATCH confirm), `extraction_failed -> extracting` (reprocess), `confirmed -> confirmed` (edit, emits updated). XML ingest goes `received -> extracted -> confirmed` inside one transaction. Pure domain function, exhaustively spec'd (R1.1).

| Event (B) | Fired when | A equivalent |
|---|---|---|
| `reception.document.confirmed` | entering `confirmed` | `invoice.confirmed` |
| `reception.document.needs_review` | entering `needs_review` (CENTRAL, first-class event in the API-first flow: it tells the ERP a person must correct; payload = id, status, `needs_review` reason code(s), link; no extracted fiscal data) | `invoice.needs_review` (never emitted in A) |
| `reception.document.extraction_failed` | entering `extraction_failed` | `invoice.extraction_failed` (never emitted) |
| `reception.document.updated` | PATCH/reprocess on a `confirmed` document (echo behavior for API-originated changes: OPEN, Q14) | `invoice.updated` |
| ~~`reception.document.deleted`~~ | OUT OF SCOPE (Q5b) | `invoice.deleted` (never emitted, no route) |

### (i) Explicitly NOT ported

| Item | Why |
|---|---|
| Human login/JWT/refresh, `cuenta` email/password, `app/application/auth`, `security/{jwt,password}.py` | B has portal auth with MFA, sessions, API keys. |
| `cuenta`, `cuenta_ruc` tables and `scripts/create_cuenta.py` | B tenants + `tenant_fiscal_profiles`; multi-RUC per tenant unsupported (Q4). |
| ARQ queue/worker | BullMQ (ADR-0013). |
| Own webhook delivery/signing/backoff/auto-pause code | B `webhooks` module is the implementation (HMAC, anti-SSRF, replay). Gaps (pause, test ping) are separate work. |
| `emitida` state, full-invoice webhook body | redundant with outbox; B payload convention is minimal. |
| `manual` origin, `boleta_resimple`, `despacho_importacion` types | no creator / no SIFEN iTiDE mapping verified. |
| Python-only helpers (`scripts/setup_app_role.py`, Alembic env, Makefile, pyproject) | B's DB role and migration flow. |
| A's `frontend/` shell (Vite app, router, token storage, Tailwind config) | B portal is Next.js; only the read-only list/detail screens are ported. |
| A's review inbox, review detail/edit/confirm, items editor, confidence badges, upload page | API-first decision (user): the tenant's ERP corrects and confirms via API `PATCH`; portal review/upload UI deferred to a future feature. |
| Data migration from A | none assumed (Q9). |
| Receiver events (conformidad, disconformidad, desconocimiento, notificación; HU-E9-01) | future work; R8.4 is a design note only. |

## 2. Architecture sketch

```
apps/api/src/modules/reception/
  domain/            received-document.ts (aggregate + status machine), received-document-status.ts, source.ts,
                     cdc-reference.ts, confidence-policy.ts, received-document-validation.ts, extraction-result.ts,
                     extraction-prompt.ts, reception-events.ts, receiver-match.ts   (pure TS; Decimal from emission)
  application/       ingest-sifen-xml.ts, ingest-from-cdc.ts, ingest-upload.ts, extract-received-document.ts,
                     correct-received-document.ts, reprocess-received-document.ts,                     list-received-documents.ts, get-received-document.ts, get-artifact.ts
    ports/           received-document-repository.port.ts, received-document-query.port.ts,
                     storage-provider.port.ts, sifen-xml-parser.port.ts, extraction-llm.port.ts,
                     pdf-renderer.port.ts, qr-decoder.port.ts, ekuatia-client.port.ts, captcha-solver.port.ts,
                     tenant-fiscal-identity.port.ts, reception-job-queue.port.ts, clock.port.ts
  infrastructure/
    adapters/        drizzle-received-document-repository.ts, drizzle-tenant-fiscal-identity.ts,
                     s3-storage-provider.adapter.ts, sifen-xml-parser.adapter.ts, anthropic-extraction-llm.adapter.ts,
                     pdf-renderer.adapter.ts, qr-decoder.adapter.ts, ekuatia-http-client.adapter.ts,
                     two-captcha-solver.adapter.ts, bullmq-reception-job-queue.adapter.ts
    http/            received-documents.controller.ts, received-document.request.ts, received-document.presenter.ts,
                     reception-http-errors.ts, portal-received-documents.controller.ts   # portal controller: read-only GETs
    enqueue-reception-events.ts
  reception.module.ts   reception.tokens.ts            # useFactory wiring, like webhooks.module.ts
apps/api/src/worker/reception-extraction.processor.ts, reception-ekuatia.processor.ts  # TenantAwareProcessor
packages/db/src/schema.ts + migrations/0046..                                          # tables, RLS, rollback
apps/web/src/features/reception/ (read-only: reception-client, received-list, received-detail, artifact-viewer)
  + apps/web/src/app/(portal)/recibidos/** (list and [id] detail only; no upload/review routes)
```

- Tenancy/RLS: every table carries `tenant_id` with FORCE RLS; all reads/writes via `TenantTransactionRunner` (API) and `TenantAwareProcessor` (worker); repository never takes a raw pool. Composite `(tenant_id, id)` FKs for items/confidences/artifact so a cross-tenant reference is impossible. Partner visibility (ADR-0014): `partner_viewer` gets NO grant on reception tables (partners see operational metadata, not document content); test in R1.x.
- Jobs: queues `reception-extraction` and `reception-ekuatia-lookup`; job payload = ids only (tenant id + document id), never bytes; processors reopen the tenant context. Retries with BullMQ backoff; terminal failure -> `extraction_failed` + event. Per-tenant concurrency and daily caps guard spend.
- Outbox: status changes and `enqueueReceptionEvents(tx, ...)` commit together (same pattern as `enqueue-document-events.ts`).
- Depcruise: existing rules cover domain/application/infrastructure layering and DB confinement. NEW rule (R0.6): `@aws-sdk/*`, `@anthropic-ai/sdk`, PDF/QR/wasm libs importable only from `modules/*/infrastructure/` (mirrors `tips-libs-confined-to-sifen-tips`); a fixture-based case in `apps/api/test/architecture/boundaries.spec.ts` for the new rule. Cross-module imports from `reception/domain` into `emission/domain/{cdc,decimal}` and `fiscal-config/domain/ruc` need no config change today (UNVERIFIED that no rule forbids cross-module imports; run `pnpm depcruise` in R0.6 to confirm).
- Web: `features/reception` must not import `app/`; design-system untouched except additive components.

## 3. ADRs to write (Spanish, B format: Estado/Fecha/Contexto/Decisión/Consecuencias/Alternativas descartadas; status Proposed -> README row added as "Propuesto")

| # | Title | Decision summary |
|---|---|---|
| ADR-0019 | Contexto acotado `reception`: documentos recibidos como agregado propio | New module and aggregate separate from `documents`/`lotes`; own tables and state machine; receiver validation derives from `tenant_fiscal_profiles` (no `cuenta_ruc`); extra RUCs unsupported; partner has no access to content (ADR-0014 consistent); reuses CDC/RUC/Decimal domain helpers. States that ADR-0010 and ADR-0014 need NO amendment (they concern issuance and partner hierarchy; this ADR extends, not contradicts). |
| ADR-0020 | Almacenamiento de objetos con SeaweedFS detrás del puerto `StorageProvider` | MinIO community is in maintenance mode; use SeaweedFS S3 API behind a hexagonal port; adapter `@aws-sdk/client-s3` + presigner, `forcePathStyle`; pinned image tag; S3 identities configured (unauthenticated by default); `-s3.externalUrl` so presigned signatures match the public host; bucket per environment, key scheme, lifecycle/retention TBD (Q8); integration test fetching a presigned URL over HTTP. Supersedes the "S3 / MinIO" line of plan v1.1 §Infra (amendment note, no edit of accepted text). |
| ADR-0021 | Pipeline de extracción, confianza por campo y política de auto-confirmación | XML = deterministic, confidence 1.0; PDF text layer + QR for CDC before LLM; vision LLM with JSON-schema output, prompt caching, fallback model, configurable model IDs; 8 curated confidence fields; single configurable threshold (default 0.85, centralized) plus arithmetic validations and mandatory fields decide `confirmed` vs `needs_review`; async via BullMQ; PDF/QR library choice and license; cost caps; data sent to Anthropic (privacy note). |
| ADR-0022 | Consulta a eKuatia por CDC con reCAPTCHA v2 (2Captcha): integración de riesgo | Optional, feature-flagged path; dedupe before solving; per-tenant daily solve cap and circuit breaker; contract unverified live, so only human-captured fixtures are authority (ADR-0012 spirit); the agent never calls eKuatia/2Captcha; legal/ToS and fragility acknowledged; fallback is upload of XML/PDF. |
| ADR-0023 | Eventos de webhook de recepción y scopes `reception:*` | Event names `reception.document.*`, minimal payload + link, deterministic event id; `reception.document.needs_review` is a first-class, central event (the ERP is the corrector): payload carries id, status, `needs_review` reason code(s) (no extracted fiscal data) and link; `confirmed` likewise; the echo policy for `updated` is OPEN (Q14); widening of the DB CHECK lists (migration) and the parity test; scopes `reception:read|write`. Amends ADR-0011's event catalogue by addition (no edit of 0011). |

No other ADR is justified: ADR-0005/0006/0016 (tenancy), 0009 (custody), 0013 (BullMQ/Drizzle), 0018 (decimals) are reused unchanged.

## 4. Task list

Format: ID · title · route (inline / delegated writer; mandatory triggers noted) · files/areas · RED tests first · acceptance · deps · proposed commit. Every task: strict TDD (RED commit then GREEN commit), `pnpm verify` before push. Estimates are planning heuristics (authored lines incl. tests), not gates. Route declaration is recorded here; trigger evidence goes in Progress when executed.

### P0 ADRs and scaffold

- [x] R0.1 ADR-0019 (commit 6a6e268) reception bounded context · inline (1 doc + README row, no research) · `docs/adr/0019-*.md`, `docs/adr/README.md` · RED: n/a (docs; structural readback) · accepted by user, README row · deps none · `docs(adr): propose ADR-0019 reception bounded context`
- [x] R0.2 ADR-0020 (commit 6a6e268) storage SeaweedFS · inline · `docs/adr/0020-*.md`, README · as above · deps none · `docs(adr): propose ADR-0020 object storage with SeaweedFS behind StorageProvider`
- [x] R0.3 ADR-0021 (commit 84a0c3d) extraction pipeline and confidence policy · delegated writer (needs library spike reading, preparation trigger) · `docs/adr/0021-*.md`, README · RED n/a · PDF/QR library choice justified with license and size; model config rule · deps R0.1 · `docs(adr): propose ADR-0021 extraction pipeline and confidence policy`
- [x] R0.4 ADR-0022 (commit 0ef73a7) eKuatia and 2Captcha risk · inline · `docs/adr/0022-*.md`, README · n/a · deps R0.1 · `docs(adr): propose ADR-0022 eKuatia lookup via 2Captcha`
- [x] R0.5 ADR-0023 (commit 28c6b9e) reception webhook events and scopes · inline · `docs/adr/0023-*.md`, README · n/a · deps R0.1 · `docs(adr): propose ADR-0023 reception webhook events and scopes`
- [x] R0.6 Module scaffold (commit 7352e78) + depcruise rule · delegated writer (2+ files) · `RM/reception.module.ts`, `reception.tokens.ts`, empty layer folders with a smoke spec, wiring in the app module, `.dependency-cruiser.cjs` rule `sdk-libs-confined-to-infrastructure`, `apps/api/test/architecture/boundaries.spec.ts` + fixture · RED: boundary spec fails for an SDK import from `domain/`, module boots empty · `pnpm depcruise` green · deps R0.1-R0.5 accepted · `feat(reception): scaffold module and confine SDK imports to infrastructure`
- [ ] R0.7 Import golden fixtures verbatim · delegated writer (preparation: read A fixtures) · `apps/api/test/fixtures/reception/{sifen,ekuatia/v2026-Q3}/**` copied from A `tests/fixtures/**` + README with provenance and "do not edit by hand" · RED: spec asserting file checksums list (`fixtures.manifest.spec.ts`) · fixtures byte-identical to A (sha256 manifest) · deps none · `test(reception): import golden SIFEN and eKuatia fixtures from facturaspy`

### P1 Schema, RLS, repository

- [ ] R1.1 Domain: aggregate, enums, status machine · delegated writer · `RM/domain/{received-document,received-document-status,source}.ts` + specs · RED: transition table exhaustive (valid/invalid), version bump rules, `needs_review` parity · deps R0.6 · `feat(reception): received document aggregate and status machine`
- [ ] R1.2 Migration `received_artifacts` + RLS · delegated writer · `packages/db/src/schema.ts`, `migrations/0046_received_artifacts.sql`, `0047_received_artifacts_rls.sql`, rollbacks, snapshot, journal · RED: `rls-coverage.spec.ts` fails before RLS; unique `(tenant_id, sha256)`; isolation test · deps R0.6 · `feat(db): received_artifacts table with forced RLS`
- [ ] R1.3 Migration `received_documents` + RLS · delegated writer · schema + `0048_received_documents.sql` + `0049_..._rls.sql` + rollbacks; CHECKs (status, source, CDC length, ruc format), partial uniques (CDC, number), composite FK to artifacts, `version`, write-guard on immutable columns (pattern `documents_guard`) · RED: constraint tests on PGlite + `db-postgres` role tests · deps R1.2 · `feat(db): received_documents table with forced RLS`
- [ ] R1.4 Migration items + field confidences + RLS · delegated writer · schema + `0050/0051` + rollbacks; composite FKs, `UNIQUE(received_document_id, field_name)` · RED: cross-tenant FK insert rejected; rls-coverage · deps R1.3 · `feat(db): received document items and field confidences with forced RLS`
- [ ] R1.5 Repository port + Drizzle adapter · delegated writer · `RM/application/ports/received-document-repository.port.ts`, `RM/infrastructure/adapters/drizzle-received-document-repository.ts`, specs on PGlite · RED: save/load graph, dedupe by CDC and by sha256 under tenant tx, other tenant sees nothing, optimistic version conflict · deps R1.1, R1.4 · `feat(reception): drizzle repository for received documents`
- [ ] R1.6 Partner isolation test · inline (1 test file) · `packages/db/test/isolation.spec.ts` addition · RED: `partner_viewer` cannot SELECT reception tables · deps R1.4 · `test(db): partner viewer has no access to reception tables`

### P2 Storage

- [ ] R2.1 `StorageProvider` port + in-memory fake + shared contract suite · delegated writer · port, `RM/infrastructure/adapters/in-memory-storage-provider.ts`, `storage-provider.contract.ts` · RED: contract (upload/download/delete/exists/presign/ping, missing key error) run against the fake · deps R0.6 · `feat(reception): storage provider port and contract suite`
- [ ] R2.2 S3 adapter + config · delegated writer · `s3-storage-provider.adapter.ts` (`@aws-sdk/client-s3` + presigner pinned, `forcePathStyle`), storage config validation (fail-fast), `docs/configuracion.md` · RED: contract suite with mocked S3 client; config rejects missing/permissive values in production · deps R2.1 · `feat(reception): S3 storage adapter and storage configuration`
- [ ] R2.3 SeaweedFS in compose, pinned, authenticated · delegated writer · `docker-compose.yml` (`seaweedfs`, bucket init), `docker/seaweedfs/s3.json.template` (identities, no real secrets), `-s3.externalUrl`, healthcheck on the S3 port (contahelper reference `docker-compose.yml`) · RED: compose smoke script/test that an anonymous PUT is refused and the signed one succeeds · image tag pinned (resolve a concrete released tag; never `latest`); flag names verified against the pinned image docs (UNVERIFIED now) · deps R2.2 · `chore(infra): add pinned authenticated SeaweedFS to docker compose`
- [ ] R2.4 Integration test vs real SeaweedFS + CI job · delegated writer · `apps/api/test/storage.seaweedfs.integration.spec.ts` (skipped without `STORAGE_ENDPOINT_URL`), `.github/workflows/ci.yml` job `storage-seaweedfs` (docker run of the pinned image with identities, readiness poll on the S3 port, bucket create) · RED: put/get, presign then plain HTTP GET of the URL returns bytes (host in signature matches `-s3.externalUrl`), unauthenticated access denied · deps R2.3 · `ci: storage-seaweedfs job with presigned URL integration test`
- [ ] R2.5 Storage ping in health · inline-or-delegated (1-2 files) · `modules/health` readiness (UNVERIFIED structure) · RED: health reports storage down · optional · deps R2.2 · `feat(health): include storage readiness`

### P3 SIFEN XML ingest

- [ ] R3.1 Domain validations + receiver match · delegated writer · `RM/domain/{cdc-reference,received-document-validation,receiver-match}.ts` + specs · RED: A cases (`test_cdc`, `test_validacion_factura`) ported on `Decimal`; RUC DV and CDC DV (NEW); receiver match by `ruc_base` + `dv` against profile; `fast-check` totals property · deps R1.1 · `feat(reception): received document validation and receiver match`
- [ ] R3.2 SIFEN rDE parser + library spike · delegated writer · `sifen-xml-parser.port.ts`, adapter, spec; spike note appended to ADR-0021 · RED: golden XMLs `factura_contado`, `factura_servicio_digital`, `success*`, `servicio_digital` parse to expected header/items; unsupported iTiDE -> typed error; XXE/DTD document rejected; huge document rejected · deps R0.7, R3.1 · `feat(reception): SIFEN rDE parser for received documents`
- [ ] R3.3 `IngestSifenXml` use case · delegated writer · `RM/application/ingest-sifen-xml.ts`, `tenant-fiscal-identity.port.ts`, Drizzle adapter · RED (fakes): stores artifact before parsing; dedupe returns existing (`created=false`); parse error leaves artifact stored; confidence 1.0; receiver mismatch stores `is_own_receiver=false` and emits NO domain/webhook event (Q3), matching receiver ends `confirmed` and emits the event · deps R1.5, R2.1, R3.2 · `feat(reception): ingest SIFEN XML with dedupe and receiver validation`

### P4 API, scopes, webhooks, OpenAPI

- [ ] R4.1 Scopes + guard wiring · inline-or-delegated · `reception:read|write` constants/docs, controller decorators skeleton · RED: 403 without scope, 401 without key · deps R0.6 · `feat(reception): reception API key scopes`
- [ ] R4.2 `POST /v1/received-documents` (async 202 for every source per Q6; XML processor first, PDF/photo/CDC processors land in P5/P6 and return a typed `unsupported_source` until then) · delegated writer · controller, request parsing (multipart/raw/JSON), `@fastify/multipart` pinned, size cap, magic bytes, error mapping · RED e2e: 202 + Location, 200 on dedupe, 413/415/422 cases, tenant isolation · deps R3.3, R4.1 · `feat(reception): POST /v1/received-documents for SIFEN XML`
- [ ] R4.3 List/get/artifact/artifact-url · delegated writer · query adapter (keyset), presenter, controllers · RED e2e: filters, cursor, `updated_since`, artifact stream and presigned URL, 404 cross-tenant · deps R4.2 · `feat(reception): list, get and artifact endpoints`
- [ ] R4.4 PATCH correct + confirm in ONE call (API-first; no DELETE, Q5b) · delegated writer · `correct-received-document.ts`, audit-chain entries, controller · requirements (final field names fixed in the RED tests, together with R4.3's GET shape): single call that corrects fields/items AND confirms (e.g. optional `confirm: true`); optimistic version check with 409 on conflict; revalidation on confirm; idempotent by version; `GET` detail (R4.3) exposes extracted fields, per-field confidences, `needs_review` reasons and artifact download link so an ERP can render its own review; actor (API key id) recorded in `confirmed_by`/`corrected_by` · RED: version conflict 409, revalidation on confirm (confirm rejected while validations fail), correct+confirm in one request, same-version replay is idempotent, field `corrected_*` persisted, audit written · deps R4.3 · `feat(reception): correct and confirm received documents via API`
- [ ] R4.5 Webhook events end to end (`reception.document.needs_review` and `.confirmed` are the central events of the API-first flow: payload = id, status, reason code(s) for `needs_review` without extracted fiscal data, and link; `.updated` echo policy per Q14, OPEN) · delegated writer · migration widening `webhook_endpoints_events_valid` and `webhook_deliveries_event_type_valid` (+ guard trigger check) + rollback, `packages/db/src/schema.ts` list, `webhook-event.ts` list, `enqueue-reception-events.ts`, `docs/integracion/webhooks.md` · RED: parity spec fails first; outbox idempotent per document+type; filter matching; e2e delivery of `reception.document.confirmed`; documents with `is_own_receiver=false` enqueue NO outbox rows for any event type (Q3) · deps R4.4, ADR-0023 · `feat(webhooks): reception document events`
- [ ] R4.6 OpenAPI + integrator docs (must specify the webhook echo contract: actor/source, document version, ERP echo-ignore rule with example; Q14) · inline-or-delegated · regenerate `docs/api/openapi.json`, `docs/integracion/recepcion.md`, `docs/configuracion.md` entries · RED: openapi sync test · deps R4.5 · `docs(reception): OpenAPI and integration guide`
- [ ] R4.7 e2e consolidation + RLS cross-tenant · delegated writer · `apps/api/test/reception.e2e.spec.ts` · RED: A integration cases (`test_ingesta_xml`, `test_rls`) ported · deps R4.4 · `test(reception): e2e coverage for ingest and isolation`

### P5 Vision extraction, reprocess, correction

- [ ] R5.1 Domain: confidence policy + extraction result · delegated writer · `RM/domain/{confidence-policy,extraction-result}.ts` · RED: decision table (global < threshold, failed validations, missing issuer fields -> `needs_review`), threshold read from config in ONE place (fixes A duplication), field list of 8 · deps R3.1 · `feat(reception): confidence policy and extraction result model`
- [ ] R5.2 Ports + prompt + zod schema · delegated writer · `extraction-llm.port.ts`, `pdf-renderer.port.ts`, `qr-decoder.port.ts`, `RM/domain/extraction-prompt.ts` (port of `prompts.py`, 269 lines), output schema via zod 4 · RED: schema parse accepts/rejects, amounts stay strings, parse_extraccion cases from `test_llm_extraccion` · deps R5.1 · `feat(reception): extraction ports, prompt and output schema`
- [ ] R5.3 Anthropic adapter · delegated writer (load `claude-api` skill) · `anthropic-extraction-llm.adapter.ts`, config model IDs, `@anthropic-ai/sdk` pinned · RED (mocked SDK): primary failure falls back once; refusal and invalid JSON mapped to typed errors; system prompt carries cache control; no key -> disabled error · deps R5.2 · `feat(reception): Anthropic vision extraction adapter`
- [ ] R5.4 PDF adapter (spike + choice) · delegated writer · adapter, spec, ADR-0021 update · RED: text layer extraction, rasterize <= max pages at dpi, empty/corrupt PDF -> typed error, page cap · license and wasm size checked and recorded · deps R5.2 · `feat(reception): PDF text and raster adapter`
- [ ] R5.5 QR adapter (spike + choice) · delegated writer · adapter + image decode · RED: QR fixture image yields CDC from `?Id=` URL; no QR -> null; corrupt image -> null · deps R5.2 · `feat(reception): QR decoder adapter`
- [ ] R5.6 Extraction use case + BullMQ processor · delegated writer · `ingest-upload.ts`, `extract-received-document.ts`, `bullmq-reception-job-queue.adapter.ts`, `apps/api/src/worker/reception-extraction.processor.ts`, wire PDF/photo in the POST controller (202) · RED (fakes, then `worker-redis`): sha256 dedupe, status path `received -> extracting -> extracted -> confirmed|needs_review`, failure -> `extraction_failed`, retries/backoff, events emitted, tenant context restored in worker · deps R5.3-R5.5, R4.5 · `feat(reception): async extraction of PDF and photo uploads`
- [ ] R5.7 Correction with field confidences · delegated writer · extend R4.4 for extracted docs: `corrected_value/by/at`, revalidation · RED: low-confidence field corrected, global confirm blocked while validations fail · deps R5.6 · `feat(reception): field-level corrections for extracted documents`
- [ ] R5.8 Reprocess · delegated writer · `reprocess-received-document.ts`, route 202 · RED: reprocess from stored artifact (XML and vision), 409 without artifact, `updated` event only if previously confirmed · deps R5.6 · `feat(reception): reprocess received documents`
- [ ] R5.9 Spend guards · delegated writer · per-tenant daily extraction cap, concurrency limit, usage logging (ids/counts) · RED: cap exceeded -> 429 `extraction_quota_exceeded` · deps R5.6 · `feat(reception): extraction quota per tenant`

### P6 eKuatia client and captcha (fixtures only)

- [ ] R6.1 Captcha port + 2Captcha adapter · delegated writer · `captcha-solver.port.ts`, `two-captcha-solver.adapter.ts` (thin fetch client unless the spike picks a library) · RED: fake local HTTP server: submit/poll/ready, timeout, error codes, missing key -> typed error; NEVER the real service · deps R0.6 · `feat(reception): captcha solver port and 2Captcha adapter`
- [ ] R6.2 eKuatia client adapter · delegated writer · `ekuatia-client.port.ts`, `ekuatia-http-client.adapter.ts` · RED: replay `v2026-Q3` captures through a local fake server (POST `/docs/documento-electronico` then GET `/docs/documento-electronico-xml/{cdc}`), 404 -> not found, other -> consult error, cookies decision documented (captures show cookies set by the site, A never propagated them) · deps R0.7, R6.1 · `feat(reception): eKuatia consultation client`
- [ ] R6.3 CDC ingest use case + job + kill switch · delegated writer · `ingest-from-cdc.ts`, `reception-ekuatia.processor.ts`, `RECEPTION_EKUATIA_ENABLED`, daily solve cap, circuit breaker · RED: dedupe BEFORE solving; QR URL and bare CDC accepted; check-digit failure rejected pre-solve; disabled -> 503; result goes through the same parser and states as XML · deps R3.3, R6.2, R5.6 · `feat(reception): ingest by CDC with spend guards`
- [ ] R6.4 Human capture + anonymize scripts · delegated writer · `apps/api/scripts/reception/capture-ekuatia.ts`, `anonymize-fixtures.ts`, README; refuse to run if `CI` is set or without an explicit `--i-am-a-human` flag · RED: anonymizer unit tests on the committed captures (no real RUC/CDC leaks), guard test · agent NEVER runs the capture script · deps R0.7 · `feat(reception): human-run eKuatia capture and anonymization scripts`
- [ ] R6.5 Runbook + docs for the eKuatia risk · inline · `docs/operacion.md` section · n/a · deps R6.3 · `docs(reception): eKuatia operational runbook`

### P7 Portal UI (READ-ONLY; API-first decision: no review/upload UI in this feature)

- [ ] R7.1 Read-only portal API for reception · delegated writer · `portal-received-documents.controller.ts` with `GET` list and `GET` detail only (session guard, `RequireActiveTenant`, as B portal), reuse read use cases; no portal POST/PATCH · RED e2e like `portal-documents.e2e.spec.ts`: list/detail, tenant isolation, `is_own_receiver=false` documents listed and flagged (Q3b), no write routes exposed (404/405) · deps R4.3 · `feat(reception): read-only portal endpoints for received documents`
- [ ] R7.2 Web feature scaffold + client + nav (read-only) · delegated writer · `apps/web/src/features/reception/reception-client.ts` (+spec), nav item, route group · RED: client 401-retry behavior like `documents-client.spec.ts` · deps R7.1 · `feat(web): reception client and navigation`
- [~] R7.3 OUT OF SCOPE (API-first, user decision): portal upload page (`upload-panel.tsx`, `recibidos/subir`). Uploads are API-only (`POST /v1/received-documents`). ID kept, not to be reused.
- [~] R7.4 OUT OF SCOPE (API-first, user decision): portal review inbox (`review-inbox.tsx`, `recibidos/revision`). The ERP is notified via the `reception.document.needs_review` webhook. ID kept, not to be reused.
- [ ] R7.5 Read-only detail (status, extracted fields, flags, items, artifact viewer; no edit, no confirm) · delegated writer, 1 PR · `received-detail.tsx`, `artifact-viewer.tsx` (stored artifact via presigned link) · RED (Testing Library): renders status and extracted fields, shows the `is_own_receiver=false` flag, artifact link/viewer, no edit or confirm controls · deps R7.1, R7.2 · `feat(web): read-only received document detail`
- [ ] R7.6 All-documents list (read-only) · delegated writer · `received-list.tsx`, page `recibidos` with status filter, `StatusBadge` mappings, `is_own_receiver=false` flag · RED: filters, pagination · deps R7.2 · `feat(web): received documents list`
- [ ] R7.7 Settings integration (deferred decision) · inline · expose reception events in webhook UI only if a webhook/API-key UI exists; otherwise document API-only (API-only is the assumption now, Q11) · deps R4.5 · `docs(reception): settings integration status`

### P8 Hardening

- [ ] R8.1 Docs: AGENTS.md map/README, `docs/integracion/recepcion.md` final, operation notes · inline-or-delegated · docs only · deps all · `docs(reception): finalize integration and operations docs`
- [ ] R8.2 Security review · delegated reviewer then writer for fixes · upload validation (magic bytes, size, page bomb), XXE, presigned URL TTL, secrets in logs, tenant leakage, prompt injection through document text (LLM output treated as untrusted data, never as instructions), plus the read-only portal detail (artifact link exposure, no write path) · RED: one regression test per finding · deps R7.5 · `fix(reception): security review findings`
- [ ] R8.3 Coverage and performance · delegated writer · coverage >= 85 % for touched packages, `latency.bench.spec.ts` style bench for XML ingest, extraction concurrency load test with fakes · deps all · `test(reception): coverage and performance baselines`
- [ ] R8.4 Receiver events design note · inline · `docs/plan/` or ADR draft for HU-E9-01 hook-up (conformidad etc. on received documents); no code · deps none · `docs(reception): receiver events hook-up design note`
- [ ] R8.5 Final gates · inline · `pnpm verify`, OpenAPI sync, rls-coverage, depcruise, CI green · deps all · no commit unless fixes

Total: 52 active tasks (P0 7, P1 6, P2 5, P3 3, P4 7, P5 9, P6 5, P7 5, P8 5); R7.3 and R7.4 are OUT OF SCOPE and kept as IDs only (54 IDs, originally planned as 54 active).

### PR groups (<= 400 authored changed lines each; record the real boundaries in Progress)

| PR | Tasks | Est. lines | Notes |
|---|---|---|---|
| PR-01 | R0.1, R0.2 | ~150 | docs only |
| PR-02 | R0.3, R0.4, R0.5 | ~250 | docs only; may be split |
| PR-03 | R0.6 | ~250 | scaffold + depcruise rule |
| PR-04 | R0.7 | fixtures (data copy, not authored logic) + ~60 | fixtures are verbatim data; confirm with the user how the 400 limit treats data files |
| PR-05 | R1.1 | ~300 | |
| PR-06 | R1.2 | ~250 | |
| PR-07 | R1.3 | ~380 | |
| PR-08 | R1.4, R1.6 | ~350 | |
| PR-09 | R1.5 | ~380 | |
| PR-10 | R2.1 | ~250 | |
| PR-11 | R2.2 | ~350 | |
| PR-12 | R2.3, R2.5 | ~200 | |
| PR-13 | R2.4 | ~250 | |
| PR-14 | R3.1 | ~380 | |
| PR-15 | R3.2 | ~400 | split parser mapping vs error handling if over |
| PR-16 | R3.3 | ~350 | |
| PR-17 | R4.1, R4.2 | ~390 | |
| PR-18 | R4.3 | ~380 | |
| PR-19 | R4.4 | ~390 | |
| PR-20 | R4.5 | ~380 | migration + parity |
| PR-21 | R4.6, R4.7 | ~380 | |
| PR-22 | R5.1, R5.2 | ~400 | |
| PR-23 | R5.3 | ~350 | |
| PR-24 | R5.4 | ~300 | |
| PR-25 | R5.5 | ~250 | |
| PR-26 | R5.6 | ~400 | split processor vs use case if over |
| PR-27 | R5.7, R5.8 | ~400 | |
| PR-28 | R5.9 | ~200 | |
| PR-29 | R6.1 | ~300 | |
| PR-30 | R6.2 | ~350 | |
| PR-31 | R6.3 | ~400 | |
| PR-32 | R6.4, R6.5 | ~350 | |
| PR-33 | R7.1 | ~250 | read-only GET endpoints only |
| PR-34 | R7.2, R7.6 | ~350 | client + nav + read-only list |
| PR-35 | R7.5, R7.7 | ~300 | read-only detail + viewer; settings note |
| PR-36 | R8.1, R8.4 | ~300 | (was PR-38; R7.3/R7.4 out of scope removed two PRs, numbers renumbered) |
| PR-37 | R8.2, R8.3 | ~400 | (was PR-39) |

Forecast: ~11,800 authored changed lines across 37 PRs (sum of the table above; the earlier "~12,000 / 39 PRs" figure was rounded and included the removed review/upload UI). Because it exceeds 400, apply the delivery strategy before the next commit after P0: ask the user once for `stacked-to-main` vs `feature-branch-chain`; resolve skills `work-unit-commits` and `chained-pr` by registry name before opening any PR (never hardcode paths). Native review (receipt-driven development) applies per work-unit commit or PR slice only when the user-owned switch is on; assessed tier/outcome is recorded per task.

## 5. Risks and open questions (owner = user decision unless noted)

| ID | Item | Owner |
|---|---|---|
| R-1 | eKuatia contract never verified against the live service (A client docstring; only 3 captures + consulta page exist). Parsing of the first POST response unknown; cookies unmodeled. Mitigation: ADR-0022, fixtures only, human capture (R6.4), feature flag. | user (accept risk, run capture) |
| R-2 | Legal/ToS and fragility of automating a reCAPTCHA-gated public site with a paid solver; site key may rotate. | user |
| R-3 | 2Captcha spend: each lookup costs a solve; caps and dedupe-before-solve are in R6.3. Cap values? | user |
| R-4 | Anthropic cost/limits/latency per page (5 pages x 200 dpi PNG); privacy: invoice images leave the platform; PII/tax data policy and DPA. Per-tenant caps R5.9. | user |
| R-5 | PDF rasterization and QR wasm/native choice (license incl. AGPL risk of mupdf, binary size, Node 22 cold start, `sharp` native binaries in CI/Docker). Resolved in R5.4/R5.5 spikes with ADR-0021 update. | tech lead (spike) |
| R-6 | SeaweedFS: unauthenticated by default (identities required), flag names/`externalUrl` behavior must be verified against the pinned image; image tag not yet chosen; single-node durability and backup; retention/lifecycle of artifacts. | tech lead + user (retention) |
| R-7 | XML parser safety (XXE, entity expansion) and library choice; non-FE document types need fixtures (B can generate signed XML for NCE/NDE/AFE with its own emitter to create golden files). | tech lead |
| R-8 | Prompt injection via document content; LLM output is untrusted (validate with zod + arithmetic checks, never act on instructions). | tech lead |
| R-9 | Migration numbering conflicts with parallel branches (0046+ today). | tech lead |
| R-10 | Webhook DB CHECK widening touches shared tables; guard trigger interplay (`webhook_endpoints` guard) must be re-tested. | tech lead |
| R-11 | Tenants without an ERP integration have no UI to correct `needs_review` documents until a future feature (review UI). Mitigation: they can use the API directly (`GET` + `PATCH`); future review UI feature; read-only portal list/detail shows status so they at least see what is pending. | user (accept, schedule future UI) |
| Q1 | DECIDED by user: module `reception`, API `/v1/received-documents`, web route `/recibidos`. | user |
| Q2 | DECIDED by user: primary `claude-sonnet-5`, fallback `claude-haiku-4-5` (A defaults from `app/config.py`), both configurable via env. Exact fallback ID string confirmed at R5.3. | user |
| Q3 | DECIDED by user: receiver mismatch is stored with `is_own_receiver=false` and is never sent in a webhook. Q3b DECIDED by user: mismatched documents stay visible and flagged (`is_own_receiver=false`) in API list/detail and the portal; not hidden by default. | user |
| Q4 | DECIDED by user: one RUC per tenant (a company cannot have several RUCs). A `cuenta_ruc` is DROPPED; receiver validation compares against the single RUC in `tenant_fiscal_profiles`. | user |
| Q5 | Webhook payload DECIDED by user: minimal + link (B convention), not the full document. Q5b DECIDED by user: delete is OUT OF SCOPE (no DELETE route, no `reception.document.deleted` event). | user |
| Q6 | DECIDED by user: POST is asynchronous for every source (202 + Location; 200 on dedupe). Q6b DECIDED by user: `Idempotency-Key` is optional (natural idempotency by CDC/sha256). | user |
| Q7 | DECIDED by user via Q1: web route `/recibidos`. | user |
| Q8 | DECIDED by user: no expiration for now (artifacts kept indefinitely; no lifecycle rules, no delete). The user states the legal minimum retention is 5 years (stated by user, not independently verified); a retention policy is a future feature and must never expire artifacts before 5 years. | user |
| Q9 | DECIDED by user: no data to migrate from A; the port starts from an empty database. | user |
| Q10 | DEFERRED / moot (user, API-first): no portal write actions in this feature. Verified portal roles (`apps/api/src/modules/identity/domain/portal-role.ts`): `owner`, `admin`, `emisor`, `lector`. Future recommendation, to be decided when a review UI is built: owner/admin/emisor may correct/confirm, lector read-only. | user (when review UI is built) |
| Q11 | DECIDED by user: settings UI for API keys/webhooks is a future feature; API-only here. | user |
| Q12 | DECIDED by user: copied fixtures (data, byte-identical, sha256 manifest) do NOT count against the 400-line PR limit; they ship in their own PR (R0.7). | user |
| Q13 | DECIDED by user: webhook parity gaps vs A (auto-pause after 10 failures, test ping, reactivate) become a SEPARATE ODD feature, not part of reception. To be opened as its own `odd/tasks/` document. | user |
| Q14 | DECIDED by user: option (a), always emit `reception.document.updated`, with an explicit actor/source field in the payload. CONDITION (user): the contract must be specified precisely so an ERP can resolve echoes logically: the payload carries the actor (`api_key` id or `portal`/`system`), the document `version` after the change, and the `status`; the integration guide must document the exact rule for an ERP to ignore its own echoes (e.g. same API key + version it just wrote) and show an example. Event contract is part of ADR-0023 and of the OpenAPI/webhook docs (R4.6). Original question: echo suppression. When the ERP syncs a correction via API `PATCH`, should `reception.document.updated` be emitted to the originating webhook endpoint (risk of echo loop) or suppressed for changes made by the API key that owns/receives the webhook? Options: (a) always emit, loop-safety documented via a `source`/actor field in the payload; (b) suppress for the same API key's endpoints; (c) emit only on the confirm transition. Recommendation (not decided): (a), with an `actor`/`source` field in the minimal payload so the ERP can ignore its own echoes. | user |

## 6. Cross-links (A, read-only; base `/home/rodrigo/workspace/facturaspy`)

- Routes: `app/api/routes/facturas.py`, `webhooks.py`, `api_keys.py`, `health.py`; schemas `app/api/schemas/{factura_patch,webhook,api_key}.py`; upload cap `app/api/file_upload.py`; errors `app/api/errors.py`; deps/scopes `app/api/dependencies.py`.
- Use cases: `app/application/facturas/{ingesta_xml,ingesta_cdc,ingesta_extraccion,reprocess,correccion,consulta,emision,presentacion,receptor}.py`, `app/application/webhooks/use_cases.py`, `app/application/cuentas/use_cases.py`.
- Domain: `app/domain/{cdc,enums,validacion_factura,webhook_backoff}.py`.
- Infra: `app/infrastructure/{captcha,ekuatia,extraction,llm,queue,security,sifen,storage,webhooks,db}/`, config `app/config.py`.
- Models: `app/infrastructure/db/models/{factura,artefacto,cuenta,api_key,webhook}.py`; migrations `migrations/versions/*`.
- Tests: `tests/unit/*`, `tests/integration/*`; fixtures `tests/fixtures/sifen/**`, `tests/fixtures/ekuatia/v2026-Q3/**`; scripts `scripts/{capture_ekuatia,anonymize_fixtures,_capture_common}.py`.
- Frontend: `frontend/src/pages/{SubirPage,RevisionListPage,RevisionDetailPage,FacturasListPage,AjustesPage,LoginPage}.tsx`, `components/ArtefactoViewer.tsx`, `api/*.ts`.
- contahelper (storage reference, read-only): `/home/rodrigo/workspace/contahelper/docker-compose.yml`, `.github/workflows/ci.yml`, `app/infrastructure/storage/s3.py`.
- B anchors: `AGENTS.md`, `docs/adr/`, `packages/db/src/schema.ts`, `packages/db/test/rls-coverage.spec.ts`, `apps/api/src/modules/{webhooks,identity,portal-documents,emission,fiscal-config,custody}`, `apps/api/src/worker/`, `apps/web/src/features/documents/`, `odd/tasks/hu-e11-01-webhooks.md` (template), `docs/integracion/webhooks.md`.

## Progress

2026-11-06: plan approved; P0 started. R0.1 and R0.2 done inline (route: inline; trigger evidence: 2 docs + 1 README row, no research; no delegation trigger fired). ADR-0019 and 0020 are `Propuesto`, pending user acceptance. Chain strategy still to be asked before the next commit after P0. Plan history: authored and revised to API-first (portal review/upload UI out of scope; R7.3 and R7.4 marked OUT OF SCOPE; 52 active tasks, 37 PR groups). Decided so far: Q1, Q2, Q3, Q3b, Q4, Q5, Q5b, Q6, Q6b, Q7, Q8, Q9, Q10 (deferred). Q11, Q12, Q13 and Q14 also decided (see rows). NO open product questions remain. Awaiting ADR acceptance (R0.1-R0.5) and the delivery chain strategy choice. No feature branch, no engram mirror yet (create `odd/reception/tasks` mirror when the first write starts; local file is source of truth until then).

## Verification evidence

R0.1/R0.2: structural readback only (passive docs; `docs/` and `*.md` are in `.prettierignore`, so `format:check` does not apply). Commit 6a6e268 `docs(adr): propose ADR-0019 ... and ADR-0020 ...`; review tier: passive, no native review. R0.3-R0.5: docs only, structural readback; R0.3 by delegated writer (preparation trigger), R0.4/R0.5 inline. R0.6 (delegated writer, commit 7352e78): RED observed (`vitest run test/architecture src/modules/reception`: 2 files failed, boundary rule missing + module unresolved), GREEN 7/7; depcruise (root and apps/api configs, run as binaries) no violations; prettier clean. PARTIAL for environmental reasons: `pnpm` shim broken (corepack lacks pnpm.cjs, binaries run directly, no `pnpm install`), `markdown-it` missing (4 spec files + tsc/eslint errors in markdown-it-renderer.adapter.ts, same without the change), 6 e2e/bench files fail at startup (presumed no Postgres, per-file cause unconfirmed); full suite 160 files/2002 tests pass. Native review of range R0.1-R0.6: tier high (hot_path: security word in ADR-0023), consent granted by the user, 4 lenses, approved, acknowledged (lineage review-faa4c3fef88f6dc8); earlier docs-only candidate review-2cf155f069cf2482 was low/approved. Per task, record `<command>: <observed result>` and the work-unit commit id here.

## Authorized scope

Authorized now: this planning document only. Not authorized until the user approves the plan: any source/migration/ADR/compose/CI write, new dependencies, running docker, any network call. Hard prohibitions at all times: real calls to eKuatia or 2Captcha, reading `.env*`, writing to `/home/rodrigo/workspace/facturaspy`.

## Acceptance criteria (feature level)

- All four received-document sources (SIFEN XML, CDC/KuDE link via eKuatia, PDF, photo) work end to end with the state machine of section (h); XML ingest is idempotent by CDC; PDF/photo by sha256.
- Every new tenant table has forced RLS and passes `rls-coverage.spec.ts`; partner role has no access; cross-tenant e2e green.
- Storage runs on pinned, authenticated SeaweedFS; the presigned URL integration test passes in CI.
- Webhook events `reception.document.*` delivered with HMAC through the existing module; DB CHECKs, domain list and parity spec agree.
- API-first end to end: an ERP can upload, fetch (extracted fields, per-field confidences, `needs_review` reasons, artifact link), correct and confirm a received document purely via the API (`PATCH` with correct + confirm in one call, optimistic version check, 409 on conflict), and receives the `reception.document.needs_review` and `reception.document.confirmed` webhooks (minimal payload + link). No portal action is required.
- Portal exposes only a read-only list and detail of received documents, showing status and the `is_own_receiver=false` flag; no upload, review, edit or confirm UI.
- OpenAPI in sync; docs in Spanish (`docs/integracion/recepcion.md`, `docs/configuracion.md`, `docs/operacion.md`).
- Coverage >= 85 % per touched package; `pnpm verify` and CI green; no real eKuatia/2Captcha traffic in any test.

## Applicable checks

`pnpm --filter @sifen/api test`, `pnpm --filter @sifen/db test` (+ `test:postgres` for role tests), `pnpm --filter @sifen/web test`, `pnpm typecheck`, `pnpm lint`, `pnpm depcruise`, `pnpm format:check`, `pnpm --filter @sifen/api openapi` (no diff), `pnpm --filter @sifen/api coverage`, `REDIS_URL=... pnpm --filter @sifen/api exec vitest run src/worker`, storage integration (R2.4), `pnpm verify`. Passive docs tasks need structural readback only.

## Next step

User reviews this document and answers the remaining open questions Q11, Q12, Q13 and Q14 (one at a time, starting with Q14 echo suppression; Q1-Q10 are decided, Q10 deferred), approves ADR drafting (R0.1-R0.5), and chooses the chain strategy before the first commit after P0.
