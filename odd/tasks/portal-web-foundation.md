# Portal web: fundación SifenFlow

- Feature: `portal-web-foundation` · Branch: `feat/hu-e12-00-web-foundation` · Refs: HU-E12-01
- Engram mirror: `odd/portal-web-foundation/tasks`
- TDD: strict (source: project/session config) · runner: Vitest 5 + Testing Library (`pnpm --filter @sifen/web test`)
- Delivery: `ask-on-risk`, chain `stacked-to-main`; ~1,700 authored lines → 4 chained PRs (one per task pair below).

## Objective

Start the client portal `apps/web` (Next.js App Router + Tailwind v4) as a faithful port of the SifenFlow
Stitch design (project 14175002856948249287), wired into every monorepo quality gate.

## Scope

- In: scaffold and tooling; Stitch tokens (ported 1:1 from the screens' Tailwind config); fonts; brand constant
  and logo; `EnvironmentBanner`, `StatusBadge`, `CdcDisplay`, `MoneyPYG`; `/` = "Panel de Control y Monitoreo
  SIFEN" shell (sidebar, topbar, hero, KPIs, recent documents) with sample data labeled "Datos de ejemplo".
- Out (later slices): billing-flow chart, Monitor SIFEN card, support card, tutorials, help dock, KPI
  sparklines, working tenant switcher (HU-E1-07), search, KuDE/XML downloads, routes `/comprobantes` and
  `/comercios`, mobile layout (Stitch only has desktop).

## Constraints

- Source of truth: Stitch screens. Deviations only for SIFEN correctness, MVP scope or hard accessibility
  failures, each listed below for PO approval.
- TypeScript 6.0.3, Node 22, ESLint 10 flat config, pnpm 12 supply-chain policy (minimum release age).
- UI copy in Spanish (`lang="es"`); code in English.

## Tasks

- [x] T1 (inline) RED: scaffold `@sifen/web` + tooling + failing `cn` spec.
- [x] T2 (inline) GREEN: Stitch tokens, fonts, layout, brand, `cn`; README. — PR 1 boundary.
- [x] T3 (inline) RED: failing specs for the four display components.
- [x] T4 (inline) GREEN: components. — PR 2 boundary.
- [x] T5 (inline) RED: failing spec for the panel shell.
- [x] T6 (inline) GREEN: sidebar + topbar + environment legend. — PR 3 boundary.
- [ ] T7 (inline) RED: failing spec for the panel content.
- [ ] T8 (inline) GREEN: hero, KPI cards, recent documents table. — PR 4 boundary.

Route: inline — a single delegated writer subagent handles every task.

## Acceptance criteria

- `@sifen/web` runs in format:check, lint, typecheck, depcruise, test, build and coverage (≥ 85 %).
- Components and `/` reproduce the Stitch classes; every deviation is listed below.
- `EnvironmentBanner` is a non-dismissible `role="status"` strip only in `test`.
- `StatusBadge` maps the eight SIFEN states plus "Desconocido"; `CdcDisplay` validates 44 digits and copies
  the raw value; `MoneyPYG` renders `₲ 12.850.000` / `-₲ 650.000`.

## Checks

`pnpm install` · `pnpm check` · `pnpm run format:check` ·
`pnpm turbo run build coverage depcruise --filter @sifen/web`

## Desviaciones del diseño de Stitch

| Qué | Dónde | Por qué |
|---|---|---|
| Se quitó el selector Pruebas/Producción del header | Topbar | SIFEN: el ambiente es del tenant y lo gestiona el operador; no es un toggle |
| Franja fija "Ambiente de prueba: los documentos no tienen valor comercial ni fiscal." (no existe en Stitch; colores de `tokens.json` `ambientePrueba`) | Encima del topbar | SIFEN: aviso obligatorio de ambiente de prueba |
| Se quitó "/ Ambiente Homologado" del chip del hero | Hero | SIFEN: ambiente contradictorio con el del tenant |
| CDC de 44 dígitos con el RUC del emisor, dígito verificador válido y prefijos iTiDE oficiales (NC = 05, AF = 04) | Tabla de comprobantes | SIFEN: Stitch usaba prefijos 04/07 erróneos, el RUC del receptor y un CDC de 43 dígitos |
| Se quitaron "Emitir Factura", "Integraciones y API", "+ Nueva Factura", "Guía Rápida", la tarjeta "Homologación DNIT" y los pasos de onboarding y el tour del hero; el texto del hero ya no menciona el onboarding | Sidebar, topbar, hero | Alcance MVP: emisión manual, API keys de autoservicio y aprendizaje son v1.0; el onboarding lo hace el operador |
| Color `outline` #777587 → #686679 | Todos los textos `text-outline` | Accesibilidad: #777587 da 4,07:1 sobre `surface-container-low` (mínimo 4,5:1) |
| Etiquetas accesibles en controles solo-icono (notificaciones, cerrar sesión, más acciones, copiar CDC) y en el buscador | Sidebar, topbar, tabla | Accesibilidad: Stitch no las tiene |
| Copiar CDC es un botón (el ícono) en vez de un `div` con `onclick` | `CdcDisplay` | Accesibilidad: el `div` no es operable con teclado |
| Animaciones `pulse`/`ping`/`spin` solo con `motion-safe` | Topbar, hero, KPI | Accesibilidad: respeta "reducir movimiento" |
| Estados sin equivalente en Stitch (borrador, firmado, en lote, observación, rechazado, cancelado, inutilizado, desconocido) usan colores de la paleta de Stitch; "Aprobado con observación" usa los de `tokens.json` | `StatusBadge` | Stitch solo muestra "Aprobado SIFEN" |
| Chip "Datos de ejemplo" | Hero | Pedido del PO: marcar los datos de ejemplo |
| Montos con `tabular-nums` | `MoneyPYG` | Alinear columnas de montos (sin cambio visible de forma) |

## Progress

- Pending.
