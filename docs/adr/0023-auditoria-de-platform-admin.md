# ADR-0023: Auditoría de cada uso de `platform_admin`

- Estado: aceptado
- Relacionados: [ADR-0005](0005-multi-tenancy-rls-schema-compartido.md), [ADR-0016](0016-tenant-transaction-runner-sin-plugin-cls.md)

## Contexto

ADR-0005 reserva `platform_admin` para jobs cross-tenant auditados, pero `audit_log` es por tenant (cadena de hashes por `tenant_id`) y las lecturas cross-tenant (CLI de operación, tenants del worker, gauges de plataforma) no dejaban registro.

## Decisión

- Tabla `platform_audit_log` sin `tenant_id`: actor, propósito, alcance (tablas o job), filas afectadas y marca de tiempo. Una única cadena SHA-256 global con la receta de `audit_log`. Solo `platform_admin` puede leer e insertar; `app_user` no tiene permisos. Un trigger rechaza `UPDATE`, `DELETE` y `TRUNCATE` para todos los roles (no hay rol de mantenimiento).
- `withPlatformAdminTransaction` (`@sifen/db`) es la única vía a `SET LOCAL ROLE platform_admin`: exige actor y propósito y escribe el registro en la misma transacción, después de `fn`. Si falla `fn` o el registro, todo se revierte; un llamador no puede olvidar la auditoría.
- Frecuencia: los comandos de operador registran una entrada por ejecución. Los jobs de sistema frecuentes (gauges cada 60 s, listado de tenants en cada ciclo) pasan `throttleSeconds` (15 min): se omite el registro si ya hay uno del mismo actor y propósito en la ventana, comprobado en SQL (vale entre reinicios y réplicas). La entrada significa "usado al menos una vez en la ventana".

## Alternativas descartadas

- Escribir en `audit_log` por tenant: no aplica a lecturas que cruzan todos los tenants.
- Un registro por ciclo: ruido sin información adicional.

## Consecuencias

El dueño de la tabla puede desactivar triggers: mantener ese rol fuera del alcance de la app. La verificación de la cadena queda como comando de operación posterior. Los registros no se purgan.
