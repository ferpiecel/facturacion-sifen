# HU-E6-07 Alertas antes de las 72 h

Objetivo: avisar al tenant, por webhook `document.transmission_deadline_warning`, a las 48 h y a las 66 h
desde la firma de un documento que sigue sin transmitirse (ADR-0008, RNF-06). Alcance MVP.

Modo TDD: estricto (`openspec/config.yaml`), runner Vitest. Ruta: delegada (un escritor).

## Diseño

- Una sola constante `TRANSMISSION_WINDOW_MS` (dominio de `transmission`), usada por el resumen del portal y el worker.
- Dedupe: id de evento determinista `evt_<sha256(documentId:tipo:umbral)>` y `UNIQUE(endpoint_id, event_id)` del outbox
  (`onConflictDoNothing`). Sin tabla ni migración nuevas: idempotente entre corridas y reinicios.
- Job repetible por tenant (`deadline-watch`), reloj inyectado, intervalo `DEADLINE_WATCH_INTERVAL_MS`.

## Tareas

- [x] T1 (PR 1, #268) Constante compartida, id/payload del evento y caso de uso, con tests (RED observado, verify OK).
- [ ] T1b (PR 2) Store Drizzle, outbox de advertencias y processor por tenant, con tests sobre PGlite.
- [ ] T2 (PR 3) Cola BullMQ, schedules por tenant, cableado del worker, config, test con Redis y documentación.

## Verificación

Se completa al cerrar cada tarea (RED, GREEN, `pnpm verify`).
