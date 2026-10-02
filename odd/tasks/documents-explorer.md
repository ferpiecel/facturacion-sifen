# Portal web: explorador "Comprobantes y KuDE"

- Feature: `documents-explorer` · Refs: HU-E12-01, HU-E12-02, HU-E12-03
- Engram mirror: `odd/documents-explorer/tasks`
- TDD: strict (source: project/session config) · runner: Vitest 5 + Testing Library (`pnpm --filter @sifen/web test`)
- Delivery: `ask-on-risk`, chain `stacked-to-main`; chained PRs (each <= 400 authored lines).

## Objective

Port the Stitch screen "Comprobantes y KuDE" to `apps/web` at `/comprobantes`, reusing the design system and
`PanelShell`. Mock data only (`GET /v1/documents` does not exist yet) behind a typed fixture shaped like the
domain so it can be swapped for the API.

## Tasks (PR cut)

- [x] PR 1 `feat/hu-e12-explorer-comprobantes`: fixture, route, header, KPI cards, nav active state.
- [x] PR 2 `feat/hu-e12-explorer-list`: fixture rows and document list.
- [x] PR 3 `feat/hu-e12-explorer-selection`: type tabs with period counts and bulk selection bar.
- [x] PR 4 `feat/hu-e12-explorer-filters`: filter bar (search, selects, chips).
- [x] PR 5 `feat/hu-e12-explorer-pagination`: pagination footer and help banner.
- [x] PR 6 `feat/hu-e12-explorer-detail`: detail panel header and KuDE preview, active row.
- [ ] PR 7 `feat/hu-e12-explorer-detail-tabs`: XML and events tabs of the detail panel.

Route: delegated writer (one) per PR; strict TDD, RED commit then GREEN commit.

## Data changes versus Stitch (tech-lead calls)

| Stitch | Ours | Reason |
|---|---|---|
| Breadcrumb root "SifenFlow" | "Inicio" | Brand is logo-only (`brand.ts`) |
| Chip "Ambiente Producción" | "Ambiente de pruebas" | Shell runs in the test environment |
| "Total Emitidos este Mes", "Periodo Oct 2024" | "Emitidos (últimos 30 días)", dates in 2026 | Matches the date filter; 2026 data |
| "BullMQ Redis" in the queue KPI | "en proceso" | Infrastructure jargon is not user-facing |
| "97.9% 1er intento" | "97.9% del total" | First-attempt rate is not tracked |
| "Ver motivos (Error 4014 / 4011)" | "Ver motivos (1321)" | 4014/4011 are not in our verified codes; 1321 is D208c, in the backlog (HU-E5-03) |
| Rejected row: "4014 RUC del receptor..." | "1321 Receptor innominado no permitido..." | Real SIFEN rule, total >= 7.000.000 Gs (NT 024) |
| Receptor/CDC/RUC values | Valid 44-digit CDCs (SET modulo 11), RUCs with valid DV, IVA 10% = total / 11 rounded | Consistent mock data |
| "NCE" CDC type 04 | iTiDE 05 (04 is AFE) | Official iTiDE codes |
| "Remisiones (NRE)" type option | Removed | Not in the MVP backlog (FE, NCE, NDE, AFE only) |
| "Aprobado DNIT" pill | "Aprobado SIFEN" (`StatusBadge`) | Design-system component |
| "Emitido hoy a las 15:42 hs" | Absolute date `02/10/2026 15:42` (America/Asuncion) | Deterministic, no clock dependency |
| "Solo con discrepancias fiscales" | "Solo con observaciones o rechazos" | "Discrepancy" has no domain meaning |
| Help banner "hasta 72hs de emitido" | "hasta 48 hs desde la aprobación para facturas y 168 hs para el resto" | HU-E8-02, plan §cancelación: FE ≤ 48 h, others ≤ 168 h from approval |
| "Ver Log DNIT" | "Ver respuesta SIFEN" | Wording |
| "Sucursales: 001-002 POS Ciudad del Este" | Establishment 002 "Sucursal Ciudad del Este" | est-point-number: 002 is the establishment |
| "Certificado: CODE100 PARAGUAY S.A." / "PKCS#7 SHA-256" | "Certificado: ACME PARAGUAY S.A." / "XMLDSig RSA-SHA256" | The DE is signed with the issuer's certificate using XMLDSig RSA-SHA256 |
| KuDE issuer "RUC: 80012345-6", validity 2024 | "RUC: 80012345-0" (valid DV), validity 2026 | Valid modulo-11 check digit; 2026 data |
| "WhatsApp al Cliente" (button and event) | "Enviar por email" | WhatsApp is not in the backlog; email is HU-E11-02 |
| Item names "Cloud SIFEN Enterprise", "HSM FIPS 140-2" | Neutral service descriptions | Infrastructure jargon in user-facing sample data |
| KuDE QR image (external URL) | QR icon placeholder | The real QR comes with HU-E5-06 / HU-E10-01 |
