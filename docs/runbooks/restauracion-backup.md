# Runbook: restauración de backup

## Estado: sin procedimiento

**Brecha.** Los backups con PITR y la restauración probada son la historia HU-E14-03 (infraestructura de producción como código), todavía no hecha. Hoy el repositorio no contiene scripts de backup, política de retención, ni un procedimiento de restauración probado, y no se documentan comandos acá para no inventarlos. RNF-09 (conservación de XML y KuDE, backups PITR cada 5 min según el plan v1.1) sigue sin cumplirse.

## Qué se puede decir hoy

- Postgres es la fuente de verdad; Redis solo coordina y los jobs del worker se reconstruyen al arrancar (`operacion.md`). Perder Redis no pierde datos de negocio.
- Lo cifrado (CSC, certificados) no se restaura sin `KMS_LOCAL_MASTER_KEY`: un backup de la base sin esa clave deja CSC y certificados irrecuperables. La clave debe respaldarse por separado y fuera de la base (ADR-0009).
- El audit log es una cadena de hashes (`verifyAuditChain`): tras una restauración conviene verificarla, con `ops audit:verify --tenant <id>` por cada tenant (ver `operacion.md`).
- Los lotes `unknown` (llamada enviada sin respuesta) se recuperan por CDC; tras restaurar a un punto anterior, documentos que SIFEN ya aprobó pueden figurar sin resultado: la consulta por CDC es el camino de reconciliación (HU-E6-04).

## Para completar cuando exista HU-E14-03

Síntomas, decisión de restaurar (a qué punto), pasos exactos, verificación (migraciones, RLS, cadena del audit log, reconciliación por CDC), escalamiento y la última prueba de restauración con fecha. Hasta entonces, ante una pérdida de datos: detener el worker y la API, no escribir sobre la base afectada y escalar al líder técnico (`<contacto-lider-tecnico>`).
