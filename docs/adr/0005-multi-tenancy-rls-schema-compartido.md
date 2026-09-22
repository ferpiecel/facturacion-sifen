# ADR-0005: Multi-tenancy con schema compartido y RLS forzado

- **Estado:** Aceptado
- **Fecha:** 2026-09-22

## Contexto
Ningún cliente puede ver registros de otro. Se esperan cientos o miles de tenants de tamaño variable.

## Decisión
Una base y un schema compartidos. Toda tabla operativa tiene `tenant_id NOT NULL`, con `ENABLE` y `FORCE ROW LEVEL SECURITY`. El rol de la aplicación **no** tiene `BYPASSRLS`. Existe un rol `platform_admin` separado solo para jobs cross-tenant auditados. La política se basa en `current_setting('app.current_tenant')`. El test de aislamiento es un gate de cada release.

## Consecuencias
El aislamiento lo garantiza la base de datos aunque la aplicación tenga un bug. Toda transacción debe setear el tenant (ADR-0006).

## Alternativas descartadas
Schema por tenant (migraciones y cantidad de objetos difíciles de gestionar). Base por tenant (costo operativo).
