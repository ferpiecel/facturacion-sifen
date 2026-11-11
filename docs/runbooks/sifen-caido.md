# Runbook: SIFEN caído

## Síntomas y detección

- Alerta de Prometheus: `SifenCircuitAbierto` y `SifenErroresDeTransporte` ([reglas](../operacion/alertas.md)).
- Log del worker: `WARN SIFEN circuit <operación>: closed -> open`.
- El resumen por ciclo muestra `deferred=<n>` (lotes `pending` sin reclamar) y, si persiste, `stalePending=<n> lotes not sent`.
- Webhook `document.transmission_deadline_warning` a las 48 h y 66 h de documentos que siguen sin transmitirse.
- La API sigue aceptando `POST /v1/documents` (202).

## Impacto

No se emite en contingencia (ADR-0008): los DE quedan firmados y encolados. El breaker es por endpoint de SIFEN, compartido por los tenants del proceso, y cada proceso worker tiene su propio estado. Un lote cuya llamada salió sin respuesta queda `unknown` y no se reenvía: se recupera por CDC (HU-E6-04). El plazo corre: 72 h desde la firma.

## Acciones inmediatas

1. Confirmar que la caída es de SIFEN y no propia: estado en el canal oficial de la DNIT (`<canal-estado-SIFEN>`) y conectividad saliente desde el host del worker.
2. No reiniciar el worker "para resetear" el breaker sin motivo: el cooldown (30 s, duplicándose hasta 15 min, una sola llamada de prueba) ya reintenta solo. Reiniciar solo pierde el estado y vuelve a contar 5 fallos.
3. No hay comando para forzar el cierre del breaker ni pausar envíos: **Brecha**. Se recupera sola al responder SIFEN.
4. Seguir los documentos próximos al plazo con [DE cerca del plazo de 72 h](de-plazo-72h.md).
5. Si la caída supera ~24 h, avisar a los tenants (canal por definir: **Brecha**, no hay notificación masiva a tenants).

## Verificación

- Log: `SIFEN circuit <operación>: open -> half-open -> closed`.
- El siguiente resumen de ciclo muestra `sent=<n>` y `deferred=0`; `stalePending` vuelve a 0.
- Lotes `unknown`: se resuelven en el ciclo de consulta; revisar que no queden.

## Escalamiento

DNIT / soporte SIFEN: `<contacto-DNIT-soporte-SIFEN>`. Escalar si SIFEN responde pero el breaker sigue abriéndose (posible error propio: certificado, red, TLS) o si hay documentos a menos de 6 h del plazo.

## Post-incidente

Registrar inicio y fin del breaker, documentos que llegaron a 48 h y 66 h, y cuántos se transmitieron fuera de plazo (aprobación con observación por extemporáneo, ADR-0008). Revisar si los umbrales del breaker necesitan ajuste.
