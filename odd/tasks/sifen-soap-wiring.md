# Cableado del gateway SOAP de SIFEN (worker y RUC)

- Feature: `sifen-soap-wiring` · Refs: MVP gap (SOAP gateway exists but is wired nowhere)
- Engram mirror: `odd/sifen-soap-wiring/tasks`
- TDD: strict (openspec/config.yaml) · runner: Vitest (`pnpm --filter @sifen/api exec vitest run <file>`)
- Delivery: `feat/sifen-soap-wiring` chained PRs, each <= 400 lines

## Objective

`SIFEN_GATEWAY=soap` lets the worker and `GET /v1/ruc/:ruc` talk to sifen-test / production with the
tenant's own certificate (ADR-0010) over mTLS. Simulator path and its guards unchanged.

## Design

- `createHttpsSoapTransport` already opens one fresh connection per call (`agent: false`) and loads
  credentials per call via `MtlsCredentialSource`; so no agent cache: the per-tenant source reads the
  cached `CertificateVault` (TTL, status re-check, audit on decrypt only) and converts the .p12 to PEM
  in memory per call (forge). Nothing is logged or kept.
- `TenantSoapGatewayFactory.forTenant(tenantId): SifenGateway` resolves the tenant's environment on
  each call (tenant transaction, `tenants.environment`) and builds the SOAP gateway for it.
- Circuit breakers stay shared by every tenant: `CircuitBreakerGateway.around(inner)` guards another
  gateway with the same breakers; worker builds `breaker.around(factory.forTenant(id))` per tenant.
- Production needs `SIFEN_SOAP_ALLOW_PRODUCTION=true` (existing `allowProduction` guard), else a
  production tenant's call fails closed. ADR-0022 records these decisions.
- RUC: the lookup takes the calling tenant and uses its gateway and environment (cache key too).

## Tasks

- [x] T1 `CircuitBreakerGateway.around` (shared breakers)
- [x] T2 PKCS#12 -> mTLS credential + tenant credential source (audit purpose `sifen-mtls`)
- [x] T3 Tenant environment reader + `TenantSoapGatewayFactory` + mTLS stub integration test
- [x] T4 `SIFEN_GATEWAY=soap` config (fail-fast), worker wiring, cycle factory per-tenant gateway, docs, ADR-0022
- [x] T5 RUC lookup per tenant over the factory; 503 only without gateway

## Progress / evidence

Route: inline single writer (small, sequential, already understood). Chain: PR1 = T1-T3, PR2 = T4, PR3 = T5.

## Handoff (writer 1 stopped at ~160k context)

- PR1 #383 (`feat/sifen-soap-wiring`, T1-T3) open, ready. PR2 (`feat/sifen-soap-wiring-worker`, T4: soap config, `createWorkerSifen`, cycle factory per-tenant gateway, env reader, docs, ADR-0022) pushed as draft, depends on #383.
- PR2 did not observe RED for `soap-gateway-config` and `drizzle-tenant-environment` (spec and impl written together); behaviour is covered.
- Remaining T5: branch `feat/sifen-soap-wiring-rucs` from PR2. RUC: `lookup(ruc)` must take the calling tenant (`cls.get(TENANT_ID_CLS_KEY)` in `RucController`), use `TenantSoapGatewayFactory.forTenant(tenantId)` (module needs `CachedCertificateVault` via `createCertificateVault` from `cli/ops.ts`, `createDrizzleTenantEnvironment`, `loadSoapGatewayConfig`), cache key environment = the tenant's environment (today deployment `SIFEN_ENVIRONMENT`); keep the simulator path and 503 only when neither gateway is configured. Reuse a breaker via `CircuitBreakerGateway.around`. Update `docs/api/openapi.json` only if the contract changes (`pnpm --filter @sifen/api openapi`).
- Build workspace packages (`pnpm --filter @sifen/db --filter @sifen/sifen-gateway --filter @sifen/sifen-xsd --filter @sifen/sifen-tips build`) before running api tests.

## Handoff 2 (writer 2)

- Blocker fix done and pushed: #383 (`66e220c`, `2bcbbf3`: `SifenTenantUnavailableError`, `SifenClientCertificateError`, `CircuitBreaker.release`, TLS pinned 1.2, `CircuitBreakerGateway.shared`), #384 restacked (`d27ffe6`). Comments posted. verify green on both.
- T5 WIP, local only, NOT pushed: branch `feat/sifen-soap-wiring-rucs` (from #384), commit `1c3e9d0`. Done: `lookup-ruc.ts` takes `(tenantId, ruc)` with `gatewayFor`/`environmentOf` (spec green); `modules/ruc/infrastructure/ruc-gateways.ts` + spec (green).
- Remaining: (1) `ruc.module.ts`: replace `RUC_GATEWAY` with a provider of `createRucGateways(process.env, { readFile: readFileSync(utf8), soap })`, where `soap` returns null without DB, else `{ environments: createDrizzleTenantEnvironment(db), certificates: { open: (t, env) => cachedVault.open(db, t, env, { actor: { type: 'system', id: 'ruc-lookup' }, purpose: 'sifen-mtls' }) }, logger }` with `new CachedCertificateVault(createCertificateVault(env, readBoundedFile))`; lookup deps `gatewayFor/environmentOf`, 503 when provider null or no db; drop `parseSifenEnvironment` from module. (2) `ruc.controller.ts`: inject `ClsService<TenancyClsStore>`, pass `cls.get(TENANT_ID_CLS_KEY)` to `lookup(tenantId, ruc)`. (3) `apps/api/test/ruc.e2e.spec.ts`: override the new token with `{ gatewayFor: () => gateway, environmentOf: () => 'production' }`; add a 503 case. (4) docs: `docs/configuracion.md` (RUC uses SIFEN_GATEWAY=soap per tenant; invalid soap config stops the API), openapi unchanged unless contract changes. (5) check depcruise (ruc module importing transmission infra), tick T5, `pnpm verify` (VITEST_MAX_WORKERS=2, one verify at a time), push, open draft PR on #384 branch with `Depende de #384`.
