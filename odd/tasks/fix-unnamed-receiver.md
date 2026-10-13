# Fix: unnamed (innominado) receiver never signs

- Feature: `fix-unnamed-receiver` · Branch: `fix/unnamed-receiver-xml` · Engram mirror: `odd/fix-unnamed-receiver/tasks`
- TDD: strict (`openspec/config.yaml`), runner Vitest. Route: delegated-free, inline (single coherent fix, one PR under 400 lines).

## Problem

An FE to "Sin Nombre" (B2C consumidor final, NT 024) is accepted with 202 but `mapInvoiceToXmlInput` throws and
`readPayload` in the signing store reports `receiver.name` missing, so the document is held
(`transmission_hold = signing:SigningDataIncompleteError`) and never reaches SIFEN.

## Normative basis

- MT v150 group D3: D201 `iNatRec` = 2; D202 `iTiOpe` = 2 (B2C); D205 `iTiContRec` and D206/D207 RUC not informed
  when D201 = 2; D208 `iTipIDRec` = 5 and D209 `dDTipIDRec` = "Innominado"; D210 `dNumIDRec` = 0 ("completar con 0");
  D211 `dNomRec` = "Sin Nombre"; address block D213-D224 optional and not informed here.
- NT 024 (Manual corrections): D208c / 1321, innominado not allowed from 7,000,000 Gs (already in `invoice-draft`).
- Validation D208b / 1319 (MT v150): innominado only when D202 = 2 (B2C). Added to `invoice-draft`.
- xmlgen (`jsonDteMain.service.js`, `generateDatosGeneralesReceptorDE`): `documentoTipo` 5 yields iTipIDRec 5,
  dDTipIDRec "Innominado", dNumIDRec "0", dNomRec "Sin Nombre"; `contribuyente: false` omits iTiContRec and RUC.

## Tasks

- [x] T1 RED: failing tests for XML mapper, 1319 draft rule, signing store re-parse, simulator end to end.
- [x] T2 GREEN: mapper (`invoice-xml.ts`), draft rule (`invoice-draft.ts`), signing store (`drizzle-signing-store.ts`).
- [x] T3 QR (`dNumIDRec=0`) and KuDE ("Sin Nombre") verified by existing specs plus the new end-to-end test.
- [x] T4 Runbook in `docs/operacion.md`: release holds `signing:SigningDataIncompleteError` after deploy.
- [ ] T5 `pnpm verify`, PR ready (not merged).

## Out of scope

B2F/B2G with a receiver without name; the Muestras medicas (D011 = 13) threshold exemption.
