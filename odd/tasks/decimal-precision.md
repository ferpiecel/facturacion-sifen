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
  0-4 decimals (widened to 0-8 by NT 023, section 1.2), `dTotBruOpeItem` (E727) and `dTotOpe` (F008) 1-15 with
  0-8 decimals, `dRedon` (F013) 1-3 with 0-4 decimals. For PYG the rounding rule is multiples of 50 Gs (Res. SEDECO 347/2014); for foreign
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
- Arithmetic validations and formats: see [T0 findings](#t0-findings-arithmetic-rules-and-tolerances).
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
| Limits follow the XSD and NT 023: `unitPrice` up to 15 integer + 8 decimal digits, `quantity` up to 10 integer + 8 decimals (the plan said 4; NT 023 widened it), `roundingPyg` up to 4 decimals | Same bounds SIFEN enforces |
| A line whose exact `quantity × unitPrice` has more than 8 decimals is rejected | The exact product then needs no rounding, so E727 and EA008 hold with equality |
| PYG rounding unchanged: multiple of 50 on the total, `roundingPyg` in 0..49 | Manual group F |
| Resolved in T0: item total (E727, EA008) is the exact product, no rounding; the validations ask for equality, not a tolerance | Manual validations 141 and 145 (codes 1859, 1853) |
| Open for T1: rounding of IVA base (E735) and IVA amount (E736), which divide and cannot be exact; interim rule: round half up to 8 decimals | The documents give no rounding mode or tolerance for them |
| Open for T1: `roundingPyg` stays integer 0..49 for now. A fractional rounding is not forbidden (F013 allows 4 decimals) but the 50-Gs table is only defined for integer guaranies | Manual group F note; confirm with the Prevalidador |

## Tasks

- [x] T0 Research: extract from the Manual and NT 003/010/014/017 the arithmetic rules and tolerances for item total, IVA and totals with decimals; record them in this document.
- [ ] T1 Evidence: send PYG documents with decimal price and quantity to the test environment or Prevalidador and record the outcome. **Blocked on test environment access and a certificate.** The TIPS reading half is done (see T0 findings); what remains is the Prevalidador evidence listed there.
- [x] T2 ADR ([ADR-0018](../../docs/adr/0018-precision-decimal-en-montos-y-cantidades.md)): decimal precision contract (representation, wire format, limits, rounding); resolve the open rows above.
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

| Task | Route | Trigger evidence |
|---|---|---|
| T0 | Delegated direct (one writer, background) | Preparation trigger: reading a 395 KB manual and 27 notes to prepare the write; PDFs converted to text with pypdf |
| T2 | Delegated direct (same writer) | Writes the ADR from the T0 findings |
| T3 | Delegated direct (same writer) | Writer trigger: value object plus its spec, TDD |

## Acceptance criteria

- `quantity: 2.3` with `unitPrice: 100` is accepted and totals 230; `quantity: 0.5` with `unitPrice: 1001`
  is accepted according to the rules settled in T0.
- Every document that is accepted today produces byte-identical XML, totals and KuDE.
- A price with more than 8 decimals, a quantity with more than 8, or a value over 15 integer digits (10 for the quantity) is
  rejected with `422` and the rule name.
- The generated XML validates against the vendored XSD and the KuDE prints the amounts.
- `pnpm check` and the coverage thresholds pass; the OpenAPI test passes after regeneration.

## T0 findings: arithmetic rules and tolerances

Sources: Manual Tecnico v150 (`MT`, validation tables of section 8 and field tables of section 7), NT 013
(20/03/2023), NT 023 (27/08/2024) and NT 001. Notes 003, 010, 014 and 017 and the remaining notes do not touch
these fields (searched for E711, E721, E727, E735, E736, EA008, F008, F013, F014 and rounding terms). The
MT field-size notation `x-yp(n-m)` is read as `x` integer digits and `n-m` decimals; the vendored XSD confirms
it (`tMontoBase`: `totalDigits` 23, `fractionDigits` 8, `minInclusive` 0, which is 15 + 8).

### Formats

| Field | Format | Source |
|---|---|---|
| `dPUniProSer` E721, `dTotBruOpeItem` E727, `dTotOpeItem` EA008, E735, E736, `dTotOpe` F008, `dTotGralOpe` F014 | up to 15 integer + 8 decimals, not negative | MT section 7 (E8.1, F); XSD `tMontoBase` |
| `dCantProSer` E711 | MT: 1-10p(0-4). **NT 023 section 1.2 (later, prevails by ADR-0012): 1-10p(0-8).** XSD: 18 digits, 8 decimals | NT 023; XSD `tdCantProSer` |
| `dRedon` F013 | up to 3 integer + 4 decimals in the MT; XSD `tdCRed` 8 digits, 4 decimals, not negative | MT section 7 (F); XSD |

### Arithmetic validations (all severity R, rejection)

| Rule | Code | Formula | Source |
|---|---|---|---|
| E727 gross item total | 1859 | `E721 * E711`, equality, no tolerance stated | MT validation 141 |
| EA008 item total | 1853 | `(E721 - EA002 - EA004 - EA006 - EA007) * E711`; self-invoice: `E721 * E711` | MT validation 145, field table |
| E735a / E735b IVA base | 1910 / 1911 | NT 013: `[100 * EA008 * E733] / [10000 + (E734 * E733)]` (replaces the MT `[EA008 * (E733/100)] / 1,05 or 1,1`). With full affectation (E733=100) this is `EA008 * 100 / (100 + E734)` | NT 013 sections 1.1 and 2.2 |
| E735 for exempt/exonerated | 1909 | `0` | MT validation 157 |
| E736a IVA amount | 1913 | `E735 * (E734 / 100)` | MT validation 161 |
| E737 exempt base (new) | 1921 | partial affectation (E731=4): `[100 * EA008 * (100 - E733)] / [10000 + (E734 * E733)]` | NT 013 section 2.1 |
| F002a, F003a, F004a, F005a subtotals | 2353, 2355, 2357, 2359 | sum of EA008 per affectation and rate; NT 013 adds `E737` to F002 and `E735 + E736` to F004/F005 when E731=4 | MT 212-219; NT 013 section 2.2 |
| F008 gross total | 2362 | `F002 + F003 + F004 + F005` (self-invoice: sum of EA008) | MT validation 220 |
| F014 net total | 2365 | `F008 - F011 - F012 - F013` (the field table says `F008 - F013 + F025`) | MT validation 223 |
| F015a, F016a IVA by rate | 2367, 2369 | sum of E736 per rate | MT 225, 227 |
| F017a total IVA | 2371 | `F015 + F016` in the validation; the field table adds `- F036 - F037 + F026` | MT 229 |
| F018a, F019a, F020a bases | 2373, 2375, 2377 | sum of E735 per rate; `F018 + F019` | MT 231-235 |

Only two tolerances exist in the documents, both about discount percentages: EA003a and EA004 (1861, 1862),
"puede haber una variacion de 0.8" (MT validations 143 and 144, NT 001). **No document states a tolerance for
the amounts above**; they read as equalities. The MT section F note says that for foreign currencies "or any
other calculation that contains decimals" the validation accepts roundings of 50 centimos (above or below);
it does not say what it applies to when the currency is PYG and the amounts have decimals.

PYG rounding (MT section F, SEDECO 347/2014): multiples of 50 Gs, example 107.437 rounds by 37 to 107.400 and
47.789 by 39 to 47.750.

### How the TIPS builder formats and rounds (`facturacionelectronicapy-xmlgen` 1.0.283)

- Default config (we pass none, `packages/sifen-tips/src/de-xml-builder.ts`): `decimals 2`, `taxDecimals 2`,
  `pygDecimals 0`, `partialTaxDecimals 8`, `pygTaxDecimals 0`, `redondeoSedeco true`.
- All math uses JS `number` and `toFixed`, so it is subject to binary float error.
- `dPUniProSer` is copied as given. `dTotBruOpeItem` and `dTotOpeItem` are `price * quantity` rounded with
  `toFixed(0)` for PYG (`jsonDteItem.service.js`). With a decimal PYG line the builder would round the item
  total to an integer and then fail E727/EA008 equality. T5 must pass `pygDecimals: 8` (and the matching tax
  options) or the output will not match our totals.
- `dBasGravIVA` uses the NT 013 formula, then `toFixed(8)`; `dLiqIVAItem` is `base * rate / 100` with
  `toFixed(8)`. The subtotals `dSub5`, `dSub10`, `dIVA5`, `dIVA10`, `dBaseGrav*`, `dTotIVA` are rounded to
  `pygTaxDecimals` (0) in PYG, so they can differ from the sum of the per-item values at 8 decimals. This is
  how accepted PYG documents behave today.
- `dRedon` comes from `redondeoSedeco`, which only reasons about the last two integer digits; it is not
  decimal aware.
- `sum0_000001SuffixBeforeToFixed` is a workaround option for the float error (adds 0.000001 before rounding).

### Resolved and open

- Resolved: item totals are exact products (no rounding) and the item-total validations are equalities;
  quantity allows 8 decimals (NT 023); formats and the 15+8 digit bounds; the TIPS defaults that must change.
- Open, goes to T1 (Prevalidador or test environment, blocked on the certificate):
  1. Rounding mode and tolerance of E735/E736 (division results). Interim: round half up to 8 decimals,
     which matches TIPS `toFixed(8)` except for binary float cases.
  2. Whether the PYG subtotals (F004, F005, F015, F016, F018, F019) must equal the sum at 8 decimals or
     may be rounded to integers as TIPS does today; and whether F008 may carry decimals in PYG.
  3. Whether `dRedon` can be fractional or the 50-centimos rule applies to PYG totals with decimals.
  4. A PYG line with `quantity 2.3 x unitPrice 100` and one with a 4-decimal quantity.

## Progress and next step

- Done: confirmed in the Manual Tecnico v150 and the notes that PYG decimals are not prohibited; mapped
  the places that assume integers.
- Done: T0 (findings above) and T2 (ADR-0018), slice A.
- Next: T3 (`Decimal` value object, slice B). T1 needs access to a SIFEN test environment and a certificate;
  T4 should not start before the T1 open points 1 and 2 are settled or an interim rule is accepted.

## Checks and evidence

- T0: sources read are listed in the findings; PDFs were converted with pypdf and searched by field id.
- None run yet for code. The integration guide (`docs/integracion/emision.md`) documents the integer rule as current
  platform behavior and must change with T8.
