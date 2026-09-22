# ADR-0006: Contexto de tenant con CLS en la API y en los workers

- **Estado:** Aceptado
- **Fecha:** 2026-09-22

## Contexto
`SET LOCAL app.current_tenant` debe ejecutarse en cada transacción. Los providers REQUEST-scoped de Nest degradan el rendimiento y se propagan a toda la cadena de dependencias. Los jobs de BullMQ no tienen request.

## Decisión
Se usa `nestjs-cls` (AsyncLocalStorage) con plugin transaccional. Un único punto abre la transacción y ejecuta `SET LOCAL`. Los processors de BullMQ heredan de `TenantAwareProcessor`, que abre el mismo contexto con el `tenant_id` del payload del job. Sin contexto, la query falla; nunca cae en un rol privilegiado.

## Consecuencias
Un único mecanismo para la API y los workers. Hay que verificar en la F0 la compatibilidad del plugin transaccional con Drizzle.

## Alternativas descartadas
Providers REQUEST-scoped; pasar el tenant explícitamente en cada llamada.
