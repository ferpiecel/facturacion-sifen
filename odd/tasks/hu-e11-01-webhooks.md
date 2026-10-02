# HU-E11-01 — Webhooks firmados del ciclo de vida

- Feature: `hu-e11-01-webhooks` · Refs: HU-E11-01, RF-02, ADR-0011 · Engram mirror: `odd/hu-e11-01-webhooks/tasks`
- TDD: strict (project config) · runner: Vitest (`pnpm --filter @sifen/api test`, `@sifen/db`)
- Delivery: `ask-on-risk`, chain `stacked-to-main`; every slice <= 400 authored lines.

## Objective

Integrators receive lifecycle events by HTTPS webhook: HMAC + timestamp, retries with backoff up to 24 h, DLQ,
delivery history (backlog HU-E11-01; ADR-0011 anti-replay 5 min; plan v1.1 §19 event list and payload).

## Slices

- [x] S1 `feat/hu-e11-01-webhooks` — pure domain in `apps/api/src/modules/webhooks/domain`: event envelope and
      `Sifen-Signature` scheme (+ verify helper, rotation overlap, secret generator); integrator doc
      `docs/integracion/webhooks.md`.
- [x] S1b `feat/hu-e11-01-webhook-backoff` (stacked on S1, split out to stay <= 400 lines) — `nextRetryAt` backoff.
- [x] S2 `feat/hu-e11-01-webhook-tables` (stacked on S1b) — migration 0028 `webhook_endpoints` (sealed secret,
      https-only url, events filter, rotation overlap), FORCE RLS. 0027 is reserved for the e6 writer; renumber at rebase.
- [x] S2b `feat/hu-e11-01-webhook-deliveries` (stacked on S2) — migration 0029 `webhook_deliveries` (retry queue, DLQ
      as `dead`, history columns), composite tenant FK, FORCE RLS. A per-attempt history table is a follow-up if
      the last-attempt columns prove too thin for the S5 history endpoint.
- [ ] S3 dispatcher service + `WebhookHttpPort` (fake in tests): SSRF guard (https only; resolve DNS, block
      private/loopback/link-local/CGNAT/metadata; connect to the vetted IP; no redirects; timeout; response cap),
      2xx = delivered, else `nextRetryAt`, null = dead; secret opened with `EnvelopeCipher` (new kind `webhook`).
- [ ] S4 outbox: enqueue `webhook_deliveries` rows in the same tenant transaction as the document status change
      (approved / approved_with_observations / rejected / cancelled / number_voided), idempotent per (event, endpoint).
- [ ] S5 API: register endpoint (secret returned once), rotate secret (overlap window), list/replay deliveries.
      Needs the event `data` shape (plan §19 payload) and `webhooks:write` scope.

Route: delegated writer per slice; strict TDD, RED commit then GREEN commit.

## Decisions

- Signature header `Sifen-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`, tolerance 300 s (ADR-0011).
  Stripe-style `v1` allows a future scheme and a multi-secret rotation overlap without a breaking change.
- Constant-time compare via `timingSafeEqual` over fixed-length digests; verify returns `malformed|mismatch|stale`
  (signature checked before time, so a forged old header leaks nothing).
- Secret `whsec_` + 256 random bits (base64url), shown once, stored only sealed (ADR-0009 custody, like the CSC).
- Backoff: 1 min x 2^n, cap 4 h, equal jitter, last attempt clamped to 24 h after the first; `null` -> dead (DLQ is the
  `dead` status of `webhook_deliveries`, queryable and replayable, not a separate queue; BullMQ stays the scheduler).
- `created_at` is UTC ISO (the plan sample shows -03:00; UTC removes ambiguity). Event id `evt_<alnum>` (ULID-compatible).
- Empty events filter = all events.

## Verification (S1)

`vitest` webhooks specs, typecheck, lint, depcruise, prettier. See PR description for results.
