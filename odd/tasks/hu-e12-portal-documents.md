# Portal: API de comprobantes (lista y detalle)

- Feature: `hu-e12-portal-documents` · Refs: HU-E12-01, HU-E12-02
- Engram mirror: `odd/hu-e12-portal-documents/tasks`
- TDD: strict (source: project config) · runner: Vitest (`pnpm --filter @sifen/api test`)
- Delivery: `ask-on-risk`, chain `stacked-to-main`; 4 PRs (#218 consulta, #219 lista, #220 detalle, XML/KuDE).

## Objective

Read-only endpoints under `/portal/documents` that the portal calls through its same-origin proxy. Authenticated
with the portal session cookie (`SessionGuard`, MFA-verified, active tenant), never an API key. Every query runs
in the active tenant's RLS transaction; the client never sends a tenant id. All four roles may read.

## Contract

- `GET /portal/documents?type&status&from&to&q&page&pageSize` -> `{ items, page, pageSize, total }`.
- `GET /portal/documents/:id` -> list item plus `environment`, `events`, `rejectionReason`; 404 outside the tenant.
- `GET /portal/documents/:id/xml` -> signed XML attachment; 404 when absent.
- `GET /portal/documents/:id/kude` -> KuDE PDF (generator exists: FE/PYG only).
- 401 without a verified session, 403 without an active tenant, 400 for invalid filters.

## Tasks

- [x] T1 (inline) RED: unit spec for the list use case and e2e spec for `GET /portal/documents`. — PR 1
- [x] T2 (inline) GREEN: port, use case, SQL adapter, controller, module. — PR 1
- [x] T3 (inline) RED+GREEN: detail endpoint and derived timeline. — PR 3 (#220)
- [x] T4 (inline) RED+GREEN: XML download and KuDE PDF routes. — PR 4

Route: inline for both (each PR is under 400 lines and the files are small and already understood).

## Constraints

- No per-status history table exists: `events` is derived from `created_at`, `signed_at` and the current status
  with the stored SIFEN messages. Recorded as debt.
- `receiverName` comes from `payload.receiver.name` (no column); unnamed receivers show "Sin Nombre".

## Debt

- Real status history (`document_events`) instead of derived events.
- `from`/`to` filter by `America/Asuncion` calendar day without index support.
- KuDE only for FE in PYG (existing generator limit).
- KuDE: the generator exists (`PdfkitKudeRenderer`); an unsigned document answers 409, a document it cannot print 422.
- `q` uses `ILIKE '%...%'` without trigram index.
