# Runbooks de operación

Procedimientos para el operador ante incidentes. Cada uno parte de lo que el código hace hoy (worker de transmisión, CLI `ops`, webhooks); lo que todavía no existe se marca como **Brecha** y no se inventan comandos para cubrirlo. Alertas y métricas: [`../operacion/alertas.md`](../operacion/alertas.md). Referencia general: [`../operacion.md`](../operacion.md) y [`../configuracion.md`](../configuracion.md).

| Runbook | Cuándo usarlo |
|---|---|
| [SIFEN caído](sifen-caido.md) | Circuit breaker abierto, lotes sin enviar (`deferred`) |
| [RUC bloqueado](ruc-bloqueado.md) | Alerta `RUC blocked by SIFEN`, tenant con envíos pausados |
| [Certificado vencido o por vencer](certificado-vencido.md) | Webhook `certificate.expiring`, `422 certificate_expiring`, retención `signing:CertificateValidityError` |
| [DE cerca del plazo de 72 h](de-plazo-72h.md) | Webhook `document.transmission_deadline_warning` |
| [Corrección con reclamo vencido](correccion-atascada.md) | `409 correction_in_progress` sin reintento del integrador |
| [Restauración de backup](restauracion-backup.md) | Pérdida o corrupción de datos (**sin procedimiento todavía**: HU-E14-03) |

## Convenciones comunes

- Los comandos del CLI exigen `OPS_DATABASE_URL` (ver `operacion.md`). Los logs del worker salen por stdout/stderr con una línea por ciclo; no hay backend de métricas ni alertas: las líneas `metric ...` son solo logs.
- **Brecha transversal, contactos DNIT:** no hay contactos oficiales cargados en el repositorio. Donde un runbook dice `<contacto-DNIT-...>`, el equipo debe completarlo antes de producción.
- **Audit log:** se consulta con `ops audit:list --tenant <id> [--action ...] [--from ...] [--to ...]` y se verifica con `ops audit:verify --tenant <id>` (ver `operacion.md`). Solo lectura, nunca imprime `before`/`after`.
- **Brecha transversal, adaptador SIFEN real:** el worker solo arranca con `SIFEN_GATEWAY=simulator` y `NODE_ENV=development|test`; en producción se niega a arrancar. Los runbooks describen el comportamiento del código ya implementado y se validan contra SIFEN real cuando exista el adaptador.
- Postmortem: plantilla mínima en cada runbook; guardar en `docs/` o el sistema de incidentes del equipo (no definido todavía).
