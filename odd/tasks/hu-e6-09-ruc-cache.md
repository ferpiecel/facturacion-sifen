# HU-E6-09: siConsRUC lookup with cache

- Feature: `hu-e6-09-ruc-cache` · Refs: HU-E6-09 (F2) · Engram mirror: `odd/hu-e6-09-ruc-cache/tasks`
- TDD: strict (`openspec/config.yaml`), runner Vitest · Delivery: `ask-on-risk`, chain `stacked-to-main`, PRs <= 400 lines
- Branch: `feat/hu-e6-09-ruc-cache` · Worktree: `/home/fer/github_proyects/facturacion-sifen-worktrees/e6-09`

## Objective

Query the taxpayer registry (`siConsRUC`) with a TTL cache so integrators can validate receivers by RUC.

## Findings (exploration)

- Port `consultarRUC`, request builder, parser, endpoint, circuit breaker and the SOAP adapter already exist (E6-08/gateway). Missing: MT v150 Tabla H codes (0500 no existe, 0501 sin permiso, 0502 encontrado), simulator scenarios and a simulator default (today unscripted `consultarRUC` rejects).
- No SOAP gateway is wired in production yet (worker only builds the simulator, `SIFEN_GATEWAY=simulator`, dev/test). The API process has no gateway: the endpoint builds the same guarded simulator and answers 503 otherwise.
- API has no Redis; it has a DB. Cache = global table `ruc_lookup_cache` (no `tenant_id`, public registry data), keyed by environment + RUC, TTL checked at read.

## Decisions

- Cache found (0502) and not-found (0500); never cache 0501 (depends on the caller's certificate) or errors.
- TTL env `RUC_CACHE_TTL_SECONDS` (default 86400, integer 0..604800; 0 disables), validated at boot.
- Endpoint `GET /v1/ruc/:ruc` (RUC without check digit, 5-8 digits). Optional validation on accept: follow-up (not in this story).
- Logs carry ids/counts only; never the response body or razón social.

## Tasks

- [x] A (a56538e): gateway codes 0500/0501/0502, simulator scenarios + default, tests
- [x] B (4d71598): migration 0063 `ruc_lookup_cache`, Drizzle schema, `LookupRuc` use case + store + TTL config + docs/configuracion.md
- [x] C (dd292d4): `GET /v1/ruc/:ruc` controller/module, OpenAPI regenerated, docs

## Routes / evidence

(per task, filled as tasks close)

Follow-up: optional receiver validation by RUC on document accept; real SOAP gateway wiring (endpoint answers 503 without the simulator).
