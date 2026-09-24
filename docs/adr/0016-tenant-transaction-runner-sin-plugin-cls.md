# ADR-0016: `TenantTransactionRunner` singleton en vez del plugin transaccional de nestjs-cls

- **Estado:** Aceptado
- **Fecha:** 2026-09-24

## Contexto

ADR-0006 propone `nestjs-cls` con su plugin transaccional (`@nestjs-cls/transactional`) como el único punto que abre la transacción y ejecuta `SET LOCAL`, y deja pendiente verificar en F0 la compatibilidad de ese plugin con Drizzle. F1 (HU-E1-01/03) implementa el punto de entrada real, `withTenantTransaction`, y esa verificación de compatibilidad no se hizo: las versiones publicadas del adapter Drizzle del plugin no están confirmadas contra `drizzle-orm@0.45.3`.

## Decisión

`packages/db/src/tenant-transaction.ts` expone `withTenantTransaction(db, tenantId, fn)` como función standalone, sin depender de `nestjs-cls` ni de su plugin transaccional. Valida `tenantId` como UUID antes de emitir SQL, abre `BEGIN` vía `db.transaction`, fija el tenant con `select set_config('app.current_tenant', $1, true)` (parámetro vinculado, nunca interpolado en el texto SQL) y ejecuta `SET LOCAL ROLE app_user` antes de correr `fn`. `apps/api` (F1, HU-E1-03 en adelante) sigue usando `nestjs-cls` solo para propagar el `tenant_id` vía `AsyncLocalStorage` desde el guard hasta el único singleton `TenantTransactionRunner`, que internamente llama a `withTenantTransaction`. No hay providers `Scope.REQUEST` (ADR-0006 ya los rechaza).

## Consecuencias

El punto de entrada transaccional es una función de `packages/db`, framework-free y testeable sin Nest. `TenantTransactionRunner` es la única pieza que conoce CLS; si el plugin transaccional de `nestjs-cls` se valida más adelante y aporta valor real (por ejemplo, anidar transacciones automáticamente), se puede adoptar reemplazando la implementación interna de `TenantTransactionRunner` sin tocar `withTenantTransaction` ni el código de dominio que lo consume.

### Rol de login del runtime

`SET LOCAL ROLE app_user` solo aísla si la sesión no puede volver atrás. Si el pool del runtime se conecta como superusuario o dueño de las tablas, `RESET ROLE` o `SET ROLE platform_admin` dentro de `fn` evaden RLS. Por eso el runtime (`apps/api`, `apps/worker`) se conecta siempre como `app_login`: `LOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, `NOINHERIT`, sin tablas propias y con `app_user` como única membresía. Sin `SET ROLE app_user` no tiene acceso a ninguna tabla, y `RESET ROLE` lo deja en ese estado. Las migraciones corren con el rol dueño. La migración `0001_rls.sql` reafirma atributos y membresías de los tres roles aunque ya existan; la contraseña de `app_login` se configura fuera de las migraciones.

PGlite no puede abrir una sesión como rol no superusuario (su opción `username` es solo un `SET ROLE`), así que las pruebas de escape corren únicamente en el job `db-postgres` (`DB_TEST_DRIVER=postgres`), que debe ser un check obligatorio de `main`.

## Alternativas descartadas

Adoptar `@nestjs-cls/transactional` ahora, sin verificar su compatibilidad con Drizzle: se descarta porque introduciría una dependencia externa sin confirmar en el camino crítico de aislamiento de tenants (ADR-0005), el requisito de seguridad más sensible del proyecto.
