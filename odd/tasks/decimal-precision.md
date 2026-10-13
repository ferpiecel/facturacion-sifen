# Decimal precision in amounts and quantities

- Feature: `decimal-precision` · Refs: HU-E5-09 (F2; found while documenting `POST /v1/documents`)
- Engram mirror: `odd/decimal-precision/tasks`
- TDD: strict (source: `openspec/config.yaml`, `strict_tdd: true`) · runner: Vitest (`pnpm --filter @sifen/api exec vitest run`, thresholds 85%)
- Delivery: `ask-on-risk`, chain `stacked-to-main`; each PR about 400 changed lines or less (advisory).
- Status: planned, nothing implemented. Replaces the earlier idea of a narrow "float false rejection" fix.

## Objective

Accept and compute amounts with the decimal precision SIFEN allows, with exact arithmetic, instead of the
current rule "PYG amounts are integers". Keep PYG as the only currency in this feature; leave a clean seam for
foreign currencies.

## Problem (gap analysis)

- The platform rejects any `unitPrice` or `quantity × unitPrice` that is not an integer
  (`invoice-draft.ts`, rule `pyg-integer`). The origin is an internal assumption in the first validation
  commit (`fcfa377`); neither the Manual Tecnico v150 nor the technical notes require it.
- Manual Tecnico v150 formats: `dPUniProSer` (E721) 1-15 with 0-8 decimals, `dCantProSer` (E711) 1-10 with
  0-4 decimals, `dTotBruOpeItem` (E727) and `dTotOpe` (F008) 1-15 with 0-8 decimals, `dRedon` (F013) 1-3 with
  0-4 decimals. For PYG the rounding rule is multiples of 50 Gs (Res. SEDECO 347/2014); for foreign
  currencies the validation accepts roundings of 50 centimos.
- Amounts are computed with JavaScript `number`: `2.3 * 100` is `229.99999999999997`, so a valid line is
  rejected, and the same product feeds the document total (`accept-invoice.ts`).
- The integer assumption is spread over several places: draft validation, `accept-invoice.ts` (`netTotal`),
  the KuDE (`formatPyg` throws on non-integers; the reader's `pyg()` accepts only `^-?\d+(\.0+)?$`) and
  the integration guide.
- The database already stores `numeric(23,8)`, so storage is not the constraint.
- `currency` only accepts `PYG` and the XML fixes `moneda: 'PYG'`; invoices in USD are not possible.

## Normative basis

- Manual Tecnico v150, groups E8, E8.1.1 and F (field formats above; section F rounding note).
- To be extracted in T0: the arithmetic validations SIFEN applies to item totals, IVA base and amount, and
  totals when there are decimals, with their tolerances and error codes.
- Precedence follows ADR-0012; Prevalidador evidence settles contradictions.

## Scope

In: exact decimal arithmetic for PYG documents; validation, totals, XML, KuDE, QR, API contract and docs.
Out: foreign currency, exchange rate (`dTiCamIt`), 50-centimos rounding, discounts and advances,
`unitPrice` semantics other than IVA included. A follow-up feature `multi-currency` will cover them.

## Constraints

- Exact arithmetic only: no `number` multiplication or addition on money or quantities in the domain.
- Domain stays framework free and the value type stays pure (ADR-0003).
- Accepting more inputs must not change any already accepted document: integer inputs produce the same XML,
  totals and KuDE as today.
- Rounding for PYG stays "total rounded down to a multiple of 50 Gs".
- Amounts stay within 15 digits plus up to 8 decimals; the larger range needs BigInt-based arithmetic.
- No new dependency without need; if a decimal library is chosen it is pinned exactly.

## Technical decisions (to record in ADR-0018; 0017 is reserved by `receiver-geo-catalog`)

| Decision | Rationale |
|---|---|
| Domain `Decimal` value object over BigInt scaled integers (scale 8) | Exact, no dependency, covers 15+8 digits |
| Wire format of `unitPrice`, `quantity`, `roundingPyg`: keep JSON number, also accept decimal strings | Backward compatible; strings give exact values beyond 15 significant digits |
| A JSON number is converted through its shortest decimal string; numbers with more than 15 significant digits are rejected | Avoids silent binary-float drift |
| Limits follow the Manual: `unitPrice` up to 8 decimals, `quantity` up to 4 decimals | Same bounds SIFEN enforces |
| PYG rounding unchanged: multiple of 50 on the total, `roundingPyg` in 0..49 | Manual group F |
| Open: how SIFEN rounds item total, IVA base and IVA amount with decimals | Resolve in T0 and confirm in T1 before coding T4 |
| Open: whether `roundingPyg` may be fractional when the total has decimals | Resolve in T0 |

## Tasks

- [ ] T0 Research: extract from the Manual and NT 003/010/014/017 the arithmetic rules and tolerances for item total, IVA and totals with decimals; record them in this document.
- [ ] T1 Evidence: send PYG documents with decimal price and quantity to the test environment or Prevalidador and record the outcome. **Blocked on test environment access and a certificate.** Also read how the TIPS builder formats and rounds amounts (needs the library installed).
- [ ] T2 ADR: decimal precision contract (representation, wire format, limits, rounding); resolve the open rows above.
- [ ] T3 Domain `Decimal` value object: parse, compare, add, multiply, scale checks, string output. Tests first, including `2.3 × 100`, `0.5 × 1001` and 15+8 digit bounds.
- [ ] T4 Draft validation and totals: replace `Number.isInteger` and `number` math in `invoice-draft.ts` and `accept-invoice.ts`; new rules for decimal places and ranges; keep the 50 Gs rounding rule.
- [ ] T5 XML and QR: format amounts as plain decimal strings (no exponent), item totals and `dTotOpe`/`dTotGralOpe`; XSD validation of generated XML; QR parameter formatting.
- [ ] T6 Persistence and read: confirm `numeric(23,8)` round-trips, `trimDecimals` in `get-document.ts`, portal summary sums and KPIs; no migration expected, confirm.
- [ ] T7 KuDE: print decimals when present (`formatPyg`, `formatQuantity`, reader `pyg()`), keep integer output identical.
- [ ] T8 API contract and docs: OpenAPI schema for the amount fields, regenerate (`pnpm --filter @sifen/api openapi`), update `docs/integracion/emision.md` (amounts and rounding section).
- [ ] T9 End to end: accept, sign and XSD check with decimal quantities and prices; coverage thresholds hold.

## PR slices (chained, each about 400 changed lines or less)

| PR | Content | Depends on |
|---|---|---|
| A | T0 results in this document + T2 (ADR) | none (T1 informs but does not block) |
| B | T3 `Decimal` value object | A |
| C | T4 validation and totals | B |
| D | T5, T6, T7 XML, QR, persistence check and KuDE (split in two if over budget) | C |
| E | T8, T9 contract, docs and end to end | D |

## Route declaration

Recorded per task when it starts. T4 to T7 touch several non-trivial files across layers and are expected to
use one delegated writer each, with the value object already merged.

## Acceptance criteria

- `quantity: 2.3` with `unitPrice: 100` is accepted and totals 230; `quantity: 0.5` with `unitPrice: 1001`
  is accepted according to the rules settled in T0.
- Every document that is accepted today produces byte-identical XML, totals and KuDE.
- A price with more than 8 decimals, a quantity with more than 4, or a value over 15 integer digits is
  rejected with `422` and the rule name.
- The generated XML validates against the vendored XSD and the KuDE prints the amounts.
- `pnpm check` and the coverage thresholds pass; the OpenAPI test passes after regeneration.

## Progress and next step

- Done: confirmed in the Manual Tecnico v150 and the notes that PYG decimals are not prohibited; mapped
  the places that assume integers.
- Next: T0 (read the arithmetic validations) and T2 (ADR). T1 needs access to a SIFEN test environment.

## Checks and evidence

- None run yet. The integration guide (`docs/integracion/emision.md`) documents the integer rule as current
  platform behavior and must change with T8.
