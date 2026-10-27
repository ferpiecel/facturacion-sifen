# HU-E14-01 — End-to-end observability

- Refs: HU-E14-01, RNF-08, plan v1.1 §13, roadmap F3 · Engram mirror: `odd/hu-e14-01-observability/tasks` · TDD strict, Vitest · chained PRs <= 400 lines · no migration
- Route: delegated direct (one writer, sifen-writer). Delivery strategy: auto-chain (`stacked-to-main`), 3 slices, forecast ~1100 lines.
- Objective: vendor-neutral OpenTelemetry in API and worker, Prometheus-compatible `/metrics` (off by default), the §13 metrics the code can emit, documented alert rules linked from the runbooks.

## Decisions (technical)

- D1 Hexagonal: application code depends on a `Telemetry` port (counter/gauge/histogram + `withSpan`); the OTel adapter lives in `infrastructure` / `worker` wiring. Without config the port is a no-op (zero overhead).
- D2 Off by default. `OTEL_ENABLED` (default false), `OTEL_EXPORTER_OTLP_ENDPOINT` (http/https URL, validated, never logged), `METRICS_ENABLED` (default false), `METRICS_TOKEN` (bearer, required when metrics are enabled in production), worker `METRICS_PORT`. All validated fail-fast, messages never carry the value; documented in `docs/configuracion.md`.
- D3 Labels: `tenant_id` is NOT a label on counters/histograms (cardinality grows with tenants, and SIFEN errors are endpoint-wide). No metric carries `tenant_id` at all (the catalog whitelists label keys per metric, the adapter drops the rest); RUC block is a counter plus a count gauge, the tenant is found in the worker log line. Spans carry `tenant.id` as attribute, never as metric label. Never XML, certificates, URLs, CDC or PII in spans or labels; only operation name, SIFEN response code, job queue name.
- D4 Trace propagation limit: the API enqueues no BullMQ job; the worker's repeatable schedulers create every job. Documents move API -> worker through Postgres, so the request `trace_id` cannot ride a job without storing it (migration, out of scope). MVP: API returns/logs `trace_id`; jobs carry an optional `traceparent` in job data which the processors extract (so any producer that injects it continues the trace) and otherwise start a root trace per cycle; SIFEN calls are child spans of the cycle. Storing the request trace on the document is a follow-up.
- D5 Metric names follow plan §13 (`sifen_lote_processing_seconds`, `sifen_lote_status_total{codigo}`, `sifen_ruc_blocks_total`, `de_pending_transmission{bucket}`, `sifen_rejections_total{codigo}`) plus `sifen_request_seconds{operation}`, `sifen_circuit_state{operation}`, `certificate_expiry_days_min`.

## Tasks

- [ ] T1a (PR 1) Config validation (fail-fast), Telemetry port, metric catalog with label whitelist, no-op adapter, env docs
- [ ] T1b (PR 2) OTel adapter (traces, Prometheus metrics) and `createTelemetryRuntime`, pinned deps
- [ ] T1c (PR 3) Nest module: `/metrics` (bearer token, 404 when off), request span and `x-trace-id`
- [ ] T2 (PR 4) Worker: SDK bootstrap and metrics port, `traceparent` in job data, spans per job, tracing SIFEN gateway decorator (latency, codes, lote/rejection counters), circuit state gauge, RUC block counter replaces the log-line metric
- [ ] T3 (PR 5) Gauges `de_pending_transmission{bucket}`, RUC-blocked tenants, certificate expiry; `docs/operacion/alertas.md` + `docs/operacion/prometheus-alertas.yml`; link from every runbook in docs/runbooks and docs/operacion.md

## Authorized scope

apps/api (telemetry module, bootstrap, worker), docs, odd. Pinned exact deps (`@opentelemetry/*`). No migration.

## Progress / evidence

- Branch `full-e14` (local only, from an older main) holds the finished PR 2 and PR 3 code: the OTel adapter, `createTelemetryRuntime`, the Nest module, `/metrics`, the trace interceptor, `x-trace-id` and the e2e spec. All of it passed vitest, eslint, tsc and depcruise. Retrieve files with `git checkout full-e14 -- <path>`, and re-apply the `docs/configuracion.md` diff 3-way, because main moved.
- PR 1 (T1a) is committed on `feat/hu-e14-01-observability` (4338dd37, 894f1d3a, 2bbef55a). The first push was still running `pnpm verify` when this was written, and the PR is not opened yet (body draft: `gh pr create`, Spanish, template, `PR 1/5`). One earlier push attempt failed on a depcruise violation (domain spec importing infrastructure), fixed in 2bbef55a. A later one failed only because two verifies ran at once and collided on the coverage directory: run exactly one push at a time.
- Pinned deps used: `@opentelemetry/api` 1.10.0, `sdk-trace` 3.0.0 (`TracerProvider`, `SimpleSpanProcessor({ exporter })`), `sdk-metrics` 3.0.0, `exporter-prometheus` 0.300.0 (`preventServerStart: true`, `getMetricsRequestHandler`), `exporter-trace-otlp-http` 0.300.0, `resources` 3.0.0, `context-async-hooks` 3.0.0, `core` 3.0.0.
- Gotchas: the app has no direct `fastify` dependency (use structural request/reply types); controllers hijack the reply to serve the Prometheus text; use a fresh `InMemorySpanExporter` per test; domain specs must not import infrastructure.

## Next step

1. Confirm PR 1 is pushed (`git ls-remote`), push 2bbef55a if not, open PR 1 ready.
2. PR 2: branch `feat/hu-e14-01-otel-adapter` from PR 1; bring `otel-telemetry*.ts`, `telemetry-runtime.ts`, `apps/api/package.json` and the lockfile from `full-e14` (~300 lines).
3. PR 3: Nest module, `/metrics`, interceptor, e2e, and the `app.module.ts` import (~190 lines).
4. PR 4 (T2), PR 5 (T3) as listed above. Not started.
