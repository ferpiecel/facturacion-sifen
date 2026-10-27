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

- [ ] T1 `CircuitBreakerGateway.around` (shared breakers)
- [ ] T2 PKCS#12 -> mTLS credential + tenant credential source (audit purpose `sifen-mtls`)
- [ ] T3 Tenant environment reader + `TenantSoapGatewayFactory` + mTLS stub integration test
- [ ] T4 `SIFEN_GATEWAY=soap` config (fail-fast), worker wiring, cycle factory per-tenant gateway, docs, ADR-0022
- [ ] T5 RUC lookup per tenant over the factory; 503 only without gateway

## Progress / evidence

Route: inline single writer (small, sequential, already understood). Chain: PR1 = T1-T3, PR2 = T4, PR3 = T5.
