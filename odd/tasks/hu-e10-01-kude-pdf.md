# HU-E10-01 — KuDE en PDF de inmediato

## Objective
Integrators get the KuDE (PDF) of a signed invoice immediately after signing: QR >= 25 mm, mandatory
fields of Manual Tecnico v150 chapter 13.

## Source of truth
- MT v150 section 13: 13.3 title ("KuDE de Factura Electronica"), 13.4.1-13.4.4 field groups, 13.8.1 QR
  >= 25 mm wide (22 mm content + 3 mm quiet zone), CDC printed in 11 groups of 4 (13.4.4, section 10).
- The legend wording lives in MT figure images (no extractable text); wording taken from the SIFEN
  reference KuDE: "Consulte la validez de esta Factura Electronica con el numero de CDC impreso abajo en:
  https://ekuatia.set.gov.py/consultas". Test URL: /consultas-test/.
- Plan v1.0 chose `@react-pdf/renderer` or Puppeteer; superseded here by pdfkit (see decisions).

## Decisions
- pdfkit 0.20.2 (MIT, maintained, standard Helvetica font, no font files, no browser) over pdf-lib 1.17.1
  (MIT, unmaintained since 2022) and react-pdf/Puppeteer (heavy: React or Chromium in the API image).
- qrcode 1.5.4 (MIT) renders the existing `dCarQR` URL to PNG; the URL is never rebuilt.
- Renderer is an infrastructure adapter behind an application port; model and formatting are pure domain.
- Deterministic output: CreationDate/ModDate from the document issue date, no random metadata.
- TDD: strict. Runner: vitest (`apps/api`).
- No migrations needed in any slice (PDFs are rendered on demand; storing them is a later decision).

## Tasks (<= 400 lines each, one PR each, chained)
- [ ] S1a Deps + KudeInvoice model, formatting helpers (CDC groups, PYG, dates) and KudeRenderer port.
      Branch `feat/hu-e10-01-kude-pdf`.
- [ ] S1b pdfkit A4 renderer: header (emitter, stamp, document number), general data, receiver, items
      by VAT column, 30 mm QR, deterministic metadata. Branch `feat/hu-e10-01-kude-renderer`.
- [ ] S1c Renderer: subtotals, IVA breakdown, CDC groups and consultation legend, "n/total" page
      numbers. Branch `feat/hu-e10-01-kude-totals`.
- [ ] S2 Signed XML (+ dCarQR) -> KudeInvoice reader in application (regex tag reading, like
      invoice-qr.ts); fails closed on missing mandatory fields.
- [ ] S3 `GET /v1/documents/{id}/kude` (use case + controller, tenant scoped, 409 before signing), e2e.
- [ ] S4 (F2, HU-E10-02, out of scope) carta/cinta formats and the other 4 document types.

## Progress
Full slice-1 implementation was 696 lines, so it was split into S1a-S1c (each under 400).
