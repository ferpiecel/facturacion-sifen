# Eventos del emisor y del receptor

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

## Eventos del receptor

Cuando el tenant es el **receptor** de un DE/DTE emitido por otra parte, registra su respuesta con `POST /v1/receiver-events` (scope `documents:write`, `Idempotency-Key` obligatoria). No hace falta tener el documento en la plataforma: se identifica por su CDC. Es asíncrono como el resto: responde `202` y el worker firma y envía el evento. Los datos del receptor (RUC y razón social) salen del perfil fiscal del tenant.

```json
{ "kind": "conformity", "conformityType": "total", "cdc": "0180…44 dígitos…", "issuedAt": "2026-10-01T10:00:00" }
```

Respuesta `202 { "event_id": "…", "kind": "conformity", "cdc": "…", "status": "pending" }`.

| `kind` | Campos propios | Máximo por CDC |
|---|---|---|
| `conformity` | `conformityType` (`total` o `partial`); `estimatedReceiptAt` si es parcial | 2: parcial y luego total |
| `disconformity` | `reason` (5 a 500 caracteres) | 1 |
| `unawareness` | `reason`, `receivedAt` | 1 |
| `receipt_notice` | `receivedAt`, `totalPyg` | 1 |

Siempre: `cdc`, `issuedAt` (fecha de emisión del documento, `AAAA-MM-DDThh:mm:ss` hora de Asunción, coherente con el CDC) y, para un DTE, `approvedAt` (aprobación de SIFEN). Reglas (NT 019 y MT v150 11.6.3 a 11.6.6):

| Regla | Respuesta |
|---|---|
| Plazo de 45 días (configurable) desde la emisión de un DE o la aprobación de un DTE | 422 `receiver-event-window-expired`, con `sifenCode` y `deadline` |
| Un solo evento de cada tipo por CDC (4101, 4150, 4158, 4200, 4251) | 409 `receiver-event-already-registered` |
| Compatibilidad entre eventos (por ejemplo, no hay conformidad tras un desconocimiento: 4156) | 422 `receiver-event-incongruent` |
| Un evento contrario al último se registra como corrección | 422 `receiver-event-needs-correction` |
| El tenant necesita perfil fiscal para `unawareness` y `receipt_notice` | 422 `receiver-profile-missing` |

La plataforma solo conoce los eventos que registró ella: SIFEN, que también ve los registrados por otros medios, tiene la última palabra. Mismo `Idempotency-Key` y mismo cuerpo devuelven la misma respuesta; la misma clave con otro cuerpo, o ya usada por otro evento, 409.

### Corregir un evento del receptor

`POST /v1/receiver-events/{id}/correct`, mismo scope y cabecera. `{id}` es el `event_id` de un evento que SIFEN **aprobó**. El cuerpo es el evento que lo reemplaza, sobre el mismo CDC, más `correctionReason` (5 a 500 caracteres):

```json
{ "kind": "disconformity", "cdc": "0180…", "issuedAt": "2026-10-01T10:00:00", "reason": "Mercadería dañada", "correctionReason": "Se registró la conformidad por error" }
```

Respuesta `202 { "event_id": "…", "corrects_event_id": "…", "kind": "disconformity", "cdc": "…", "status": "pending" }`.

| Regla (MT v150, Tabla K) | Respuesta |
|---|---|
| El original está aprobado | 422 `correction-original-not-approved` |
| Solo conformidad, disconformidad y desconocimiento se corrigen | 422 `correction-kind-unsupported` |
| Una corrección no se corrige | 422 `correction-of-correction` |
| Una sola corrección por evento | 409 `correction-already-requested` |
| El original sigue siendo el último evento concluyente del CDC | 422 `correction-original-superseded` |
| El reemplazo es de tipo contrario al original | 422 `correction-kind-not-opposite` |
| Hasta 15 días (configurable) desde la aprobación del original | 422 `correction-window-expired`, con `deadline` |
| `correctionReason` de 5 a 500 caracteres | 422, campo `correctionReason` |
| El evento no existe para el tenant | 404 |

Además valen las reglas de registro del reemplazo. Plazos configurables: [`RECEIVER_EVENT_WINDOW_DAYS` y `RECEIVER_EVENT_CORRECTION_DAYS`](../configuracion.md). Pendiente de confirmar con producto: la corrección de una corrección se rechaza (lectura estricta de "una corrección por evento").
