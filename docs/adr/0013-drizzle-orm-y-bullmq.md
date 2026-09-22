# ADR-0013: Drizzle ORM para persistencia y BullMQ para procesamiento asíncrono

- **Estado:** Aceptado
- **Fecha:** 2026-09-22

## Contexto
Hace falta control fino de las transacciones para `SET LOCAL` (RLS) y colas con reintentos, delays y DLQ.

## Decisión
**Drizzle ORM** sobre PostgreSQL 16, con migraciones SQL versionadas. **BullMQ** sobre Redis 7 con colas separadas por responsabilidad (`lote-build`, `lote-poll`, `sync-submit`, `event-batch`, `deadline-watch`, `kude-render`, `notification-*`, `webhook-delivery`). El estado de negocio vive en Postgres y Redis solo coordina.

## Consecuencias
Si se pierde Redis no se pierden DE: los jobs se reconstruyen desde el estado en Postgres.

## Alternativas descartadas
Prisma (fricción con `SET LOCAL`); pg-boss (cola en Postgres, opción válida si se quiere eliminar Redis).
