# Runbook: RUC bloqueado

## Síntomas y detección

- Alerta de Prometheus: `RucBloqueado` ([reglas](../operacion/alertas.md)).
- Log: `ERROR tenant <id> RUC blocked by SIFEN: sends paused until <hora>` y el contador `sifen_ruc_blocks_total` (sin etiqueta de tenant).
- Durante la pausa: `WARN tenant <id> sends paused until <hora>` en cada ciclo.
- Fila nueva en `ruc_blocks` para el tenant.
- Disparador: SIFEN rechaza un lote con 0301 cuyo mensaje contiene la raíz "bloque" (sin distinguir mayúsculas ni acentos, `application/ruc-block.ts`). El texto exacto de SIFEN está sin confirmar: puede haber bloqueos reales no detectados, o falsos positivos.

## Impacto

Solo ese tenant: el worker pausa sus envíos 30 minutos (configurable por código; la Guía 2024 habla de 10 a 60). Los documentos del lote vuelven a la cola con espera hasta el fin de la pausa, sin gastar un intento. Consultar y recuperar lotes siguen funcionando. Otros tenants no se afectan. La API sigue aceptando documentos.

## Acciones inmediatas

1. Identificar el tenant del log y confirmar que el bloqueo es real con el tenant o la DNIT: causa típica, RUC suspendido o con obligaciones pendientes. No se resuelve desde la plataforma.
2. No liberar nada: la pausa expira sola. No hay comando para levantarla antes ni para extenderla: **Brecha**.
3. Si el RUC sigue bloqueado al terminar la pausa, el siguiente lote se rechaza otra vez y se abre una nueva pausa; los documentos no se pierden ni se retienen por esto (no gastan intentos).
4. Vigilar los plazos de 72 h de ese tenant con [DE cerca del plazo de 72 h](de-plazo-72h.md): un bloqueo largo los consume.
5. Si los documentos terminan retenidos por otra causa (`transmission:attempts-exhausted`), corregir y liberar con `document:release-holds` (ver `operacion.md`).

## Verificación

- Pasada la pausa, el ciclo no registra más `RUC blocked` y muestra `sent=<n>` para el tenant.
- Los documentos del tenant avanzan de `queued` a `submitted` y a su resultado (webhooks `document.approved`, etc.).

## Escalamiento

DNIT, mesa de ayuda de contribuyentes: `<contacto-DNIT-RUC>`. Escalar al soporte del tenant si el bloqueo es de su RUC. Si aparece el 0301 con otro texto (bloqueo no detectado), abrir un issue para ajustar `ruc-block.ts` con el mensaje real.

## Post-incidente

Anotar el texto real del mensaje de SIFEN (cierra la pregunta abierta de HU-E6-05), duración efectiva y documentos afectados.
