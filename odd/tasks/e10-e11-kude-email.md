# HU-E10-02 + HU-E11-02 — KuDE carta/cinta y email al receptor

## Objective
- HU-E10-02: KuDE in letter (existing) and ticket ("cinta") format, 80 mm and 58 mm, for the document
  types that exist (FE, NCE) with clean extension points for NDE/AFE/NRE (built by another stream).
- HU-E11-02: the receiver gets the approved document by email (KuDE PDF + signed XML), idempotent,
  through an outbox/job like the webhooks, SMTP adapter behind a port.

## Gap analysis (MT v150 chapter 13)
- 13.5 Formato 1 (carta): FE, NCE, NDE, AFE, NRE graphics. Done for FE and NCE (HU-E10-01, HU-E7-01).
  Missing: NDE, AFE, NRE (wait for the other stream; the model has `creditNote` as the only per-type block).
- 13.6 Formato 2 (cinta de papel): defined only for FE (Grafica 14, image only, no extractable text).
  Best fit for restaurants / retail. Missing entirely. The same layout is applied to NCE (same fields).
- 13.7 Cinta resumen: optional summary ticket (item count + total only). Out of MVP scope.
- 13.8.1 QR >= 25 mm wide (22 content + 3 quiet zone): must hold on 58 mm paper (about 48 mm printable).
- 13.3: page "n/total" only for multi-page; a ticket is one continuous page, so no page number.
- Restaurant pilot: thermal printers use 80 mm (about 72 mm printable) and 58 mm (about 48 mm). The PDF
  page is exactly the paper width and as tall as the content (roll paper).
- Email (RF-12): backlog row says tenant sender (SPF/DKIM) and channel per document or tenant policy.
  MVP: one platform SMTP account, `From` display name = tenant, `Reply-To` optional; per-tenant
  sender/SPF/DKIM is a documented follow-up.

## Decisions
- `KudeFormat = 'letter' | 'ticket-80' | 'ticket-58'`; `GET /v1/documents/{id}/kude?format=`, default
  `letter` (byte-identical output for FE/NCE letter).
- Port `KudeRenderer.render(invoice, format?)`; a dispatcher picks letter or ticket renderer.
- Shared fonts/QR helpers extracted from the letter renderer without touching its drawing code.
- Email: port `DocumentMailer`, nodemailer SMTP adapter (exact version), outbox table with unique key
  per document + recipient, worker job like the webhooks queue. Fail closed in production if SMTP
  config is missing unless `EMAIL_ENABLED=false`.
- TDD: strict. Runner: vitest (`apps/api`), source: `openspec/config.yaml`.

## Tasks (<= 400 lines each, one PR each)
- [x] T1a Extract fonts/sanitize/QR helpers from the letter renderer (golden output unchanged).
      Branch `refactor/hu-e10-02-kude-pdf-common`. Route: inline (mechanical refactor).
- [x] T1b Ticket renderer 80/58 mm for FE. Branch `feat/hu-e10-02-kude-ticket-renderer`.
- [ ] T1c NCE rows, dispatcher, `?format=` query, OpenAPI and docs. Branch
      `feat/hu-e10-02-kude-ticket-wiring`.
- [ ] T2 Email: port, nodemailer adapter, env config + docs/configuracion.md.
- [ ] T3 Email: outbox migration (+ RLS) and store.
- [ ] T4 Email: enqueue on approval, job that renders KuDE and sends, idempotent.
- [ ] T5 Docs (integration guide, backlog status).

## Progress
Started 2026-10-17.
