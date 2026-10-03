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
- [x] S3 dispatcher, stacked branches (each <= 400 lines): `feat/hu-e11-01-webhook-dispatcher` (SSRF address policy +
      `WebhookSecretVault`, custody kind `webhook`, AAD tenant + endpoint id + version), `-dispatcher-http`
      (`SafeWebhookHttp`: https only, resolve + block every private/loopback/link-local/CGNAT/multicast/mapped address,
      pinned connect with original Host/SNI, no redirects, 5 s connect / 10 s total, 64 KiB body cap, re-checked per
      attempt), `-dispatcher-service` (`WebhookDispatcher`: bounded claim with lease, fresh `t` per attempt, both secrets
      during overlap, 2xx = delivered, else `nextRetryAt` or dead; stores only a code or `HTTP <status>`),
      `-dispatcher-store` (Drizzle claim with `FOR UPDATE SKIP LOCKED` + lease, record).
      Not wired yet: the Nest module and the BullMQ `webhook-delivery` worker/scheduler come with S4/S5.
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

- Endpoint url: lowercase `https://` only (scheme case-insensitivity is not worth a second spelling), non-empty host,
  no userinfo, optional port, <= 2048 chars. DNS/IP checks are S3's job, not the database's.
- Secret rotation is enforced by the `webhook_endpoints` guard trigger, so even a tenant credential cannot swap
  the secret: `sealed` changes only with `secret_version + 1`, `previous_sealed = old sealed` and an overlap
  `previous_expires_at` in (now, now + 7 days]; previous_* is cleared only after it expired. The dispatcher signs
  with the current secret plus the previous one while it is unexpired (header carries both `v1`).
- Delivery is at-least-once (a lost 2xx or a crash between send and record resends after the lease). Each attempt is
  re-signed with a fresh `t`, so signatures differ per attempt; receivers dedupe by event `id` (documented in
  `docs/integracion/webhooks.md`).
- Events filter: empty = all events; duplicates rejected (`webhook_events_unique`).

## Verification (S1)

`vitest` webhooks specs, typecheck, lint, depcruise, prettier. See PR description for results.
