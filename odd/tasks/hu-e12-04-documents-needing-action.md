# HU-E12-04 Comprobantes que necesitan acción

Objetivo: el portal lista los DE que requieren acción del usuario: rechazados, retenidos (`transmission_hold`) y
pendientes cerca o más allá de las 72 h (`TRANSMISSION_WINDOW_MS`). Las acciones correctivas (cancelar, inutilizar)
llegan con E8: solo se muestran enlaces/marcadores rotulados. Más la deuda del portal: datos de muestra del panel
y del encabezado.

Modo TDD: estricto (`openspec/config.yaml`), runner Vitest. Ruta: inline por PR (cada PR toca pocos archivos nuevos
y pequeños, patrón ya existente).

## Diseño

- `GET /portal/attention` (módulo `portal-documents`): sesión + tenant activo + RLS, como `portal/summary`.
- Motivos por documento: `overdue` (pendiente pasado el plazo), `held`, `rejected`, `due_soon` (a menos de 12 h,
  `DUE_SOON_MS`). Orden: urgencia (overdue, held, rejected, due_soon), luego plazo más cercano.
- Tope de 100 filas con `total` real y `truncated`.
- Web: `/accion-requerida` con el lenguaje visual de Stitch ya usado en `apps/web`.

## Tareas

- [x] T1 (PRs 1 y 2) API `GET /portal/attention`: clasificación a2edea3, c8f6f61 (PR 1); endpoint, store SQL y e2e b35bf48 (PR 2, depende del PR 1). Dividido en dos por el límite de 400 líneas.
- [ ] T2 (PR 2) Cliente web y pantalla `/accion-requerida` + entrada de navegación.
- [ ] T3 (PR 3) Deuda: "Comprobantes recientes" con el listado real (pageSize 5) y encabezado con `/auth/me`.

## Verificación

Se completa al cerrar cada tarea (RED, GREEN, `pnpm verify`).
