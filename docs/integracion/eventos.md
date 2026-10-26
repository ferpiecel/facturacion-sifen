# Eventos del emisor

Después de que SIFEN aprueba un documento, el emisor puede actuar sobre él con eventos (`siRecepEvento`, MT v150 sección 11). Todos son asíncronos como la emisión ([ADR-0011](../adr/0011-api-asincrona-202-webhooks-idempotencia.md)): la API guarda el evento y responde 202; el worker lo firma con el certificado del tenant, lo envía en lote de hasta 15 y el resultado de SIFEN se refleja en el documento y en un webhook.

## Cancelar un documento

`POST /v1/documents/{id}/cancel`, scope `documents:write`, cabecera `Idempotency-Key` obligatoria.

```json
{ "reason": "Error en el importe facturado" }
```

Respuesta `202`:

```json
{ "event_id": "…uuid…", "document_id": "…uuid…", "status": "pending" }
```

El documento pasa a `cancelled` cuando SIFEN registra el evento (código 0600) y se emite el webhook `document.cancelled`.

Reglas (MT v150, 11.5.1 y 11.6.1):

| Regla | Código SIFEN | Respuesta |
|---|---|---|
| El motivo tiene de 5 a 500 caracteres | GEC003 | 422 `reason-length` |
| El documento está aprobado (`approved` o `approved_with_observations`) | 4002 | 422 `document-not-approved` |
| FE: hasta 48 h desde la aprobación | 4009 | 422 `cancel-window-expired` |
| AFE, NCE, NDE y NRE: hasta 168 h desde la aprobación | 4010 | 422 `cancel-window-expired` |
| Sin documentos asociados vivos (se cancelan del último al primero) | plan 2.2 | 422 `has-live-associated-documents`, con `associatedCdcs` |
| Una sola cancelación abierta por documento | 4003 | 409 `cancellation-already-requested` |

- La plataforma resta un margen de seguridad (15 minutos) al plazo, porque el instante de aprobación que guarda es el que ella conoció, posterior al que selló SIFEN.
- La confirmación del receptor no impide cancelar (NT 025). Un rechazo no consume número de evento.
- Mismo `Idempotency-Key` y mismo cuerpo devuelven la misma respuesta; la misma clave con otro cuerpo, 409.

## Inutilizar numeración

`POST /v1/numbering/inutilize`, scope `documents:write`, `Idempotency-Key` obligatoria. Inutiliza un rango de números que no se usarán (MT v150, 11.1.1).

```json
{ "timbrado": "12345678", "establishment": "001", "expeditionPoint": "002", "type": 1, "from": 10, "to": 20, "reason": "Numeración saltada por error" }
```

Respuesta `202 { "event_id": "…", "status": "pending" }`. Con 0600 de SIFEN, los documentos rechazados del rango pasan a `number_voided` y sale el webhook `document.number_voided`.

| Regla (MT v150 11.6.2) | Código SIFEN | Respuesta 422 |
|---|---|---|
| Timbrado, establecimiento y punto del tenant | 4052, 4054, 4055 | `unknown-timbrado`, `unknown-establishment`, `unknown-expedition-point` |
| Hasta 1000 números | 4067 | `range-too-large` |
| El final no precede al inicio | 4068 | `range-end-before-start` |
| Sin documentos en SIFEN dentro del rango (solo huecos y rechazados) | 4065 | `range-has-documents`, con `numbers` |
| Sin solape con otra inutilización | 4066 | `range-overlaps-voided` |
| Solo números ya emitidos | plan 8.4 | `range-beyond-issued-numbers` |

- Valores aún sin confirmar con el ambiente de pruebas y por eso configurables: el motivo admite 5 a 150 caracteres y un rango puede ser de un solo número (el MT dice "mayor", la librería TIPS acepta igual).
- Un rechazo no consume número de evento.
