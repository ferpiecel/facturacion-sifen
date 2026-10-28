# Alertas y métricas

Qué métricas emite el sistema y qué reglas de alerta las usan (HU-E14-01, plan v1.1 §13). Las reglas están en [`prometheus-alertas.yml`](prometheus-alertas.yml); cada una enlaza su runbook. Variables de entorno: [`../configuracion.md`](../configuracion.md).

## Cómo se obtienen

- API: `GET /metrics` con `Authorization: Bearer <METRICS_TOKEN>`. Responde 404 con `METRICS_ENABLED=false` (por defecto).
- Worker: mismo formato en `METRICS_PORT` (9464 por defecto) y el mismo token. Fijar `OTEL_SERVICE_NAME=sifen-worker` en el worker.
- Trazas: `OTEL_ENABLED=true` con `OTEL_EXPORTER_OTLP_ENDPOINT`. La API devuelve `x-trace-id` en cada respuesta para cruzarlo con los logs.
- Ninguna métrica lleva `tenant_id`, CDC ni URL. Para saber qué tenant está afectado, usar el log del worker o el CLI `ops`.

## Métricas

| Métrica | Tipo | Etiquetas | Qué mide |
|---|---|---|---|
| `sifen_request_seconds` | histograma | `operation` | Latencia de cada llamada a SIFEN |
| `sifen_request_errors_total` | contador | `operation`, `outcome` (`transport`, `timeout`, `error`) | Llamadas a SIFEN que fallaron |
| `sifen_lote_status_total` | contador | `codigo` | Respuestas de lote por código (0300, 0301, 0361, 0362, 0364) |
| `sifen_rejections_total` | contador | `codigo` | Documentos rechazados por código (`other` si no es de 4 dígitos) |
| `sifen_ruc_blocks_total` | contador | - | Bloqueos de RUC reportados por SIFEN |
| `sifen_circuit_state` | gauge | `operation` | 0 cerrado, 1 semiabierto, 2 abierto (por proceso worker) |
| `platform_gauge_errors_total` | contador | - | Refrescos fallidos de los gauges entre tenants; mientras falle, los gauges conservan el último valor publicado |
| `de_pending_transmission` | gauge | `bucket` (`<24h`, `24-48h`, `48-72h`, `>72h`) | Documentos firmados sin aprobar, por antigüedad desde la firma |
| `sifen_ruc_blocked_tenants` | gauge | - | Tenants con envíos pausados por bloqueo de RUC |
| `certificate_expiry_days_min` | gauge | - | Días hasta el vencimiento del certificado activo más próximo |

Los gauges de `de_pending_transmission`, `sifen_ruc_blocked_tenants` y `certificate_expiry_days_min` los publica el worker cada 60 s leyendo como `platform_admin`; solo se calculan con `METRICS_ENABLED=true`. Se agregan en SQL (`COUNT`/`GROUP BY`), sin cargar filas en el worker. Si la consulta falla, se **conservan** los últimos valores (un cero falso silenciaría las alertas) y se incrementa `platform_gauge_errors_total`; alertar si crece sostenidamente.

## Reglas y runbooks

| Alerta | Condición | Severidad | Runbook |
|---|---|---|---|
| `SifenCircuitAbierto` | circuito abierto 2 min | crítica | [SIFEN caído](../runbooks/sifen-caido.md) |
| `SifenErroresDeTransporte` | más de 0,05 fallos/s durante 10 min | aviso | [SIFEN caído](../runbooks/sifen-caido.md) |
| `RucBloqueado` | algún tenant bloqueado o un bloqueo nuevo en 15 min | crítica | [RUC bloqueado](../runbooks/ruc-bloqueado.md) |
| `DocumentosCercaDelPlazo72h` | documentos en `48-72h` durante 10 min | aviso | [DE cerca del plazo de 72 h](../runbooks/de-plazo-72h.md) |
| `DocumentosFueraDelPlazo72h` | documentos en `>72h` | crítica | [DE cerca del plazo de 72 h](../runbooks/de-plazo-72h.md) |
| `CertificadoPorVencer` | menos de 30 días | aviso | [Certificado vencido](../runbooks/certificado-vencido.md) |
| `CertificadoVenceEstaSemana` | menos de 7 días | crítica | [Certificado vencido](../runbooks/certificado-vencido.md) |

## Brechas conocidas

- **Tasa de rechazo > 5 %** (plan §13): no hay contador de documentos aprobados, así que el cociente no se puede calcular todavía. `sifen_rejections_total` ya permite alertar por tasa absoluta.
- **`sifen_lote_processing_seconds`** (envío a 0362) figura en el catálogo pero aún no se emite: requiere el instante de envío del lote.
- **Alerta a menos de 6 h de las 72 h**: el gauge agrupa en `48-72h`; la ventana fina de 66 a 72 h la cubre hoy el webhook `document.transmission_deadline_warning`.
- **Traza de la API al worker**: los documentos pasan por Postgres, no por un job; el `trace_id` de la request no continúa en el worker (seguimiento: guardarlo en el documento).
