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
- [x] T1b (PR 1, #301) Orden de urgencia vencido, retenido, por vencer, rechazado: 656ff47 (con e2e de más de 100 rechazados).
- [x] T2 (PRs #303 y #304) Cliente web db5d23c, 777c0be (`hold` como unión de códigos estables); pantalla `/accion-requerida` cec3626, fd071b8 (etiquetas de retención), 54de127 (plazo solo para vencidos y por vencer). #304 es borrador sobre #303 y se rebasa sobre `main` cuando #301 y #303 se mergeen.
- [ ] T3 Deuda del portal en tres rebanadas: (a) encabezado con empresa y rol reales 2213f0b (#305); (b) tabla de comprobantes recientes 4b0cdc3 (#306); (c) cableado del panel sin datos de muestra a3875a0 (pendiente de PR, depende de (a) y (b)). Falta el nombre del usuario: requiere `displayName` en `/auth/me`.

## Verificación

Se completa al cerrar cada tarea (RED, GREEN, `pnpm verify`).
