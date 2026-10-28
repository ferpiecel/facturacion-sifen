# Runbook: DE cerca del plazo de 72 h

## Síntomas y detección

- Alerta de Prometheus: `DocumentosCercaDelPlazo72h` y `DocumentosFueraDelPlazo72h` ([reglas](../operacion/alertas.md)).
SIFEN da 72 h desde la firma para transmitir un DE (ADR-0008). El worker revisa cada `DEADLINE_WATCH_INTERVAL_MS` (5 min) y emite el webhook `document.transmission_deadline_warning` **una vez a las 48 h y una vez a las 66 h** (`threshold_hours`, `transmission_deadline`, `hours_remaining`) para documentos aún `signed`, `queued` o `submitted`. Un documento ya vencido, aprobado, rechazado o cancelado no genera aviso; uno que ya pasó las 66 h al verlo recibe los dos.

## Impacto

Pasadas las 72 h el DE se aprueba con observación por extemporáneo (ADR-0008); no se descarta. El código no deja de transmitirlo por ese motivo. Qué hace SIFEN real con un extemporáneo no está validado: **Brecha** hasta tener el adaptador real.

## Acciones inmediatas

1. Averiguar por qué no se transmite, en este orden:
   - `deferred>0` o breaker abierto: [SIFEN caído](sifen-caido.md).
   - `RUC blocked` / `sends paused`: [RUC bloqueado](ruc-bloqueado.md).
   - Documento retenido (`WARN ... held`; `transmission_hold`): corregir la causa (`establishment:contact`, `csc:add`, `certificate:add`, ver [certificado](certificado-vencido.md)) y liberar con `document:release-hold` o `document:release-holds`. Un retenido por 5 rechazos 0301 (`transmission:attempts-exhausted`) se libera igual tras corregir la causa; la liberación reinicia el contador.
   - `failures>0`: el log nombra el error; si es repetible, corregir antes de reintentar.
2. Si la causa es un documento irrecuperable (p. ej. innominado no B2C), inutilizar su numeración y reemitir (ver `operacion.md`).
3. No hay comando para listar los documentos próximos al plazo ni para forzar su transmisión: **Brecha**. Hoy: los webhooks recibidos, o SQL de solo lectura sobre `documents` por `signed_at`.
4. Informar al tenant con el `hours_remaining` del webhook.

## Verificación

- El documento avanza a `submitted` y luego a un resultado (`document.approved` o `document.approved_with_observations`).
- Un tercer aviso no existe: tras las 66 h solo cabe seguir el resultado.

## Escalamiento

DNIT: `<contacto-DNIT-soporte-SIFEN>` si SIFEN no responde cerca del plazo. Producto/tenant si el documento deberá reemitirse.

## Post-incidente

Contar los DE que cruzaron las 72 h y su causa raíz; confirmar contra SIFEN cómo se trató el extemporáneo.
