# Guía de integración: documentos recibidos

Referencia para integradores que reciben facturas de sus proveedores a través de `/v1/received-documents`. El contrato máquina-legible es [`docs/api/openapi.json`](../api/openapi.json); los eventos están en [`webhooks.md`](webhooks.md). Decisiones: [ADR-0024](../adr/0024-contexto-acotado-reception-documentos-recibidos.md), [ADR-0026](../adr/0026-pipeline-de-extraccion-confianza-y-auto-confirmacion.md) y [ADR-0028](../adr/0028-eventos-de-webhook-de-recepcion-y-scopes.md).

## Qué hace la plataforma y qué hace usted

| Responsable | Tareas |
|---|---|
| Su sistema (ERP) | Sube el documento recibido, lo consulta, corrige los datos que haga falta y lo confirma |
| Plataforma | Guarda el archivo original, lee el XML de SIFEN, valida los datos, detecta duplicados y notifica por webhook |
| Portal web | Solo lectura. No sube, no corrige ni confirma documentos |

El flujo es **API-first**: el ERP es quien corrige. La plataforma deja el documento en `needs_review` con los motivos y el ERP decide qué corregir con un único `PATCH` que corrige y confirma.

## Estado actual

Se procesan el **XML de SIFEN** (`rDE`, de forma síncrona) y los **PDF y fotos** (PNG o JPEG, de forma asíncrona con extracción por modelo de visión). La consulta por CDC llega en una fase posterior y responde `422` con `code: "unsupported_source"`:

| Fuente | Estado |
|---|---|
| XML de SIFEN (cuerpo crudo, `multipart` o JSON `{ "xml": ... }`) | Disponible |
| PDF y fotos (JPEG, PNG): cuerpo crudo o `multipart` | Disponible. Procesamiento asíncrono, ver [PDF y fotos](#pdf-y-fotos) |
| Solo el CDC (`{ "cdc": "..." }`, consulta a eKuatia) | Planificado. Hoy `422 unsupported_source` |
| Reprocesar un documento en `extraction_failed` | Disponible. Ver [Reprocesar](#reprocesar) |

## Autenticación y scopes

```http
Authorization: Bearer sk_test_...
```

- Las API keys `sk_test_...` y `sk_live_...` identifican el ambiente, igual que en [la emisión](emision.md#autenticación-y-ambientes).
- `reception:write` sube, corrige y confirma (`POST` y `PATCH`).
- `reception:read` lista, consulta y descarga (`GET`).
- Una key con scopes `documents:*` o `webhooks:*` **no** accede a estas rutas: responde `403`. Sin key o con una key inválida, `401`.
- Para recibir los eventos, la key que registra el endpoint de webhooks necesita `webhooks:write`.

Un documento de otro tenant nunca es visible: responde `404 not_found`, igual que un id inexistente.

## Estados

```text
received → extracting → extracted → confirmed
                                  ↘ needs_review → confirmed
            extracting → extraction_failed
```

| Estado | Significado |
|---|---|
| `received` | Archivo guardado, todavía sin procesar |
| `extracting` | En extracción |
| `extracted` | Datos extraídos, pendientes de validar |
| `needs_review` | Extraído, pero falló alguna validación o falta confirmar. Debe corregirlo el ERP (`needs_review_reasons`) |
| `confirmed` | Validado y confirmado. Se puede seguir editando; cada edición genera un evento `updated` |
| `extraction_failed` | El archivo no se pudo leer como documento SIFEN soportado |

Con el XML de SIFEN la lectura ocurre **dentro de la petición**: la respuesta `202` ya trae el estado final, que es `confirmed` si el documento pasa la validación o `needs_review` si no. Un XML ilegible se rechaza con `422` al subirlo (ver [errores](#errores)), pero queda guardado y se puede consultar con `GET`.

Con PDF y fotos la respuesta `202` trae `received` y el resultado llega después (ver [PDF y fotos](#pdf-y-fotos)). `extracted` es transitorio y no se llega a observar: el documento pasa de `extracting` directamente a `confirmed` o `needs_review`.

Cada documento tiene un número de `version` que empieza en 1. Sube al confirmarse y con cada edición posterior. Es lo que espera `PATCH`.

## Subir un documento

`POST /v1/received-documents` (scope `reception:write`). Tres formas de enviar el archivo (el JSON solo sirve para XML):

| Forma | Encabezado | Cuerpo |
|---|---|---|
| Cuerpo crudo | `Content-Type: application/xml`, `text/xml`, `application/pdf`, `image/png` o `image/jpeg` | Los bytes del archivo |
| Multipart | `Content-Type: multipart/form-data` | Una parte `file` (se guarda el nombre original) |
| JSON | `Content-Type: application/json` | `{ "xml": "<rDE ...>" }` (tope de 1 MiB) |

El contenido se reconoce por sus **primeros bytes**, no por el tipo declarado: un `Content-Type: application/pdf` con un XML dentro se procesa como XML; con bytes que no son XML, PDF, PNG ni JPEG, `415`.

| Respuesta | Cuándo | Cuerpo |
|---|---|---|
| `202` | Documento nuevo. Incluye `Location: /v1/received-documents/{id}`. Con PDF o foto, `status` es `received` | `{ "id", "status", "version", "source" }` |
| `200` | Ya se había recibido (mismos bytes o mismo CDC). Incluye `Location` | Lo mismo, del documento existente |
| `4xx` / `503` | Ver [errores](#errores) (`503 queue_unavailable` trae además `document_id`) | `{ "statusCode", "code", "message" }` |

El cuerpo de la respuesta es solo un acuse. Los datos fiscales se leen con `GET`.

### PDF y fotos

El archivo se guarda, se registra el documento en `received` y se encola su extracción. Un worker lo lee con un modelo de visión (hasta 5 páginas a 200 dpi), intenta leer el QR de la factura para obtener el CDC, valida los datos como cualquier otro documento y deja el documento en:

- `confirmed`: la confianza global supera el umbral configurado, el emisor está completo y las validaciones pasan.
- `needs_review`: algo requiere revisión. Además de los motivos de validación de siempre, hay dos propios de esta fuente: `low_confidence` (la confianza global no alcanza el umbral) e `items_without_subtotals` (hay ítems pero ninguno trae subtotal, así que la suma no se puede verificar).
- `extraction_failed`: no se pudo extraer. `extraction_error_code` lo explica: `corrupt_pdf`, `empty_pdf`, `too_many_pages`, `llm_disabled` (la extracción no está habilitada en el servicio), `llm_refusal`, `llm_invalid_output`, `llm_provider_error`, `llm_rate_limited`, `duplicate_document` (el CDC extraído ya pertenece a otro documento), `artifact_missing`, `internal_error`. Los fallos transitorios (proveedor, límite de tasa, error interno) se reintentan con espera creciente hasta 3 intentos en total (la primera ejecución más 2 reintentos); el evento `extraction_failed` se envía solo cuando el fallo es definitivo.

Para saber cuándo terminó, escuche los webhooks `reception.document.confirmed`, `reception.document.needs_review` y `reception.document.extraction_failed`, o consulte el documento con `GET` hasta que su estado deje de ser `received` o `extracting`.

Si la cola de extracción no está disponible, la respuesta es `503 queue_unavailable` con el `document_id`: el archivo **queda guardado** y el documento en `received`. Volver a subir los mismos bytes lo encola de nuevo (responde `200`). Los servicios sin Redis configurado responden siempre `503 queue_unavailable` para PDF y fotos; el XML no se ve afectado.

### Tope diario de extracciones

Cada PDF o foto que se encola para extracción (una subida nueva o un [reproceso](#reprocesar) que encola un trabajo) consume un cupo del tenant en el día UTC. El tope es `RECEPTION_EXTRACTION_DAILY_CAP` (por defecto 200, ver [configuración](../configuracion.md)). Superado, la respuesta es `429 extraction_quota_exceeded` con el encabezado `Retry-After` (segundos hasta las 00:00 UTC) y los campos `cap` y `retry_after_seconds`; la subida no guarda el archivo ni crea el documento.

- El XML SIFEN no cuenta (no usa el modelo) y sigue funcionando con el tope agotado.
- Una subida duplicada (los mismos bytes) responde `200` y no consume cupo. Si el duplicado seguía en `received` porque su trabajo nunca se encoló, reencolarlo sí consume cupo; con el tope agotado responde `200` sin encolar y el reproceso lo recupera al día siguiente.
- Si la cola rechaza el trabajo (`503 queue_unavailable`), el cupo se devuelve.
- El cupo se toma de forma atómica: dos subidas simultáneas no pueden pasar el tope.

### Duplicados

- **Mismo contenido** (sha256 de los bytes): responde `200` con el documento existente, sin crear nada ni emitir eventos.
- **Mismo CDC** con bytes distintos (por ejemplo, el XML reenviado con otra firma): responde `200` con el documento que ya existía y se descarta el archivo nuevo.
- Para todo lo demás, el `POST` no usa `Idempotency-Key`: la idempotencia es natural, por contenido y por CDC. Reintentar una subida es seguro.

### Tamaño máximo

Por defecto 2 MiB por archivo (un XML de SIFEN pesa unos KB, pero una foto de celular puede superar ese valor: el operador debe subirlo para fotos). Lo cambia el operador con `RECEPTION_MAX_UPLOAD_BYTES` (entre 1 byte y 15 MiB), ver [`configuracion.md`](../configuracion.md). Lo que lo supera responde `413 payload_too_large`.

### Receptor que no es el tenant

Si el RUC receptor del XML no corresponde al tenant (`is_own_receiver = false`), el documento se guarda y se valida como cualquier otro, pero **no genera ningún evento de webhook**, de ningún tipo. Se puede listar (`?is_own_receiver=false`) y corregir. Si la plataforma no puede probar que el receptor es el tenant (sin perfil fiscal o sin RUC receptor en el XML), también lo trata como no propio. Un XML ilegible, en cambio, se trata como propio y sí emite `extraction_failed`.

## Listar

`GET /v1/received-documents` (scope `reception:read`). Del más nuevo al más viejo, con paginación por cursor.

| Parámetro | Descripción |
|---|---|
| `limit` | 1 a 200. Por defecto 50 |
| `cursor` | El `next_cursor` de la página anterior. `next_cursor` es `null` en la última página |
| `status` | Uno de los [estados](#estados) |
| `source` | `sifen_xml`, `ekuatia_cdc`, `pdf` o `photo` |
| `issuer_ruc` | RUC del emisor con o sin dígito verificador (`80000001` u `80000001-8`) |
| `issued_from`, `issued_to` | Fechas de emisión `YYYY-MM-DD`, ambas inclusivas |
| `is_own_receiver` | `true` o `false` |
| `cdc_prefix` | Primeros dígitos del CDC (hasta 44) |
| `updated_since` | Instante ISO 8601, inclusivo. Para sincronización incremental |

Un parámetro mal formado responde `400 invalid_request`.

```json
{
  "items": [
    {
      "id": "5b3f0f4e-7a49-4b61-9a5e-3a1f2c9d8e10",
      "status": "needs_review",
      "source": "sifen_xml",
      "version": 1,
      "needs_review": true,
      "is_own_receiver": true,
      "document_type": 1,
      "cdc": "01800000018001001000000112026101010000000014",
      "issuer": { "ruc": "80000001-8", "name": "Proveedor de Ejemplo S.A." },
      "document_number": "001-001-0000001",
      "issued_on": "2026-11-01",
      "currency": "PYG",
      "total_amount": "110000",
      "total_vat": "10000",
      "confidence_overall": "1",
      "confirmed_at": null,
      "has_artifact": true,
      "created_at": "2026-11-10T15:00:00.000Z",
      "updated_at": "2026-11-10T15:00:00.000Z"
    }
  ],
  "next_cursor": null
}
```

Para **sincronizar de forma incremental**, guarde el mayor `updated_at` que vio y pídalo como `updated_since` la próxima vez; como el límite es inclusivo, descarte lo que ya procesó (por `id` y `version`).

## Consultar un documento

`GET /v1/received-documents/{id}` (scope `reception:read`). Trae todo lo que un ERP necesita para armar su propia pantalla de revisión:

- Cabecera: `status`, `source`, `version`, `needs_review`, `needs_review_reasons`, `is_own_receiver`, `extraction_error_code`, `extraction_attempts`, `confidence_overall`, `document_type`, `cdc`, `timbrado`, `series`, `establishment_code`, `expedition_point_code`, `document_sequence`, `document_number`, `issued_on`, `currency`, `exchange_rate`.
- Bloques `issuer`, `receiver`, `payment` y `totals` (los mismos nombres que acepta `PATCH`), más `sifen` (`status`, `authorized_at`, `protocol_number`).
- `items[]`, sin los ítems eliminados (ver [eliminar ítems](#eliminar-ítems)).
- `field_confidences[]`: `field`, `confidence`, `extracted_value`, `corrected_value`, `corrected_by`, `corrected_at`.
- Trazabilidad: `confirmed_at`, `confirmed_by`, `corrected_at`, `corrected_by` (última corrección; el historial completo está en el registro de auditoría de la plataforma), `created_at`, `updated_at`.
- `artifact` (`id`, `content_type`, `size_bytes`, `sha256`, `original_name`, `page_count`) y `artifact_url`.

Los montos y cantidades son **cadenas decimales** sin ceros finales (`"10.5"`, no `10.50000000` ni un número JSON). Nunca se exponen claves de almacenamiento ni el contenido crudo extraído. Con un XML de SIFEN todos los campos de confianza valen `"1"`.

Motivos en `needs_review_reasons`: `missing_issuer_ruc`, `missing_issuer_legal_name`, `missing_document_number`, `missing_issue_date`, `missing_totals`, `issuer_ruc_invalid_format`, `issuer_ruc_check_digit_mismatch`, `invalid_document_number_format`, `invalid_issue_date`, `cdc_invalid`, `cdc_check_digit_mismatch`, `invalid_amount`, `totals_blocks_sum_mismatch`, `vat5_inconsistent`, `vat10_inconsistent`, `items_sum_mismatch`, y `awaiting_confirmation` (los datos son válidos, solo falta confirmar).

## Descargar el archivo original

Los bytes subidos se guardan tal cual.

| Ruta | Respuesta |
|---|---|
| `GET /v1/received-documents/{id}/artifact` | Los bytes, con el tipo de contenido guardado y `Content-Disposition: inline; filename="..."`. Requiere la API key |
| `GET /v1/received-documents/{id}/artifact-url` | `{ "url": "...", "expires_in_seconds": 900 }`: un enlace directo y temporal (15 min), que se puede entregar a un navegador sin la API key |

Ambas responden `404 not_found` si el documento no existe o no tiene archivo, y `503 storage_unavailable` si el almacenamiento no está disponible.

## Corregir y confirmar

`PATCH /v1/received-documents/{id}` (scope `reception:write`), cuerpo JSON. Corrige campos e ítems y, opcionalmente, confirma, **en una sola llamada**. Solo se acepta en `needs_review` y `confirmed`; en cualquier otro estado responde `409 invalid_state` (con `status`).

### Cuerpo

El cuerpo tiene la misma forma anidada que `GET`, de modo que se puede devolver lo que se leyó con los cambios aplicados. Es estricto: un campo desconocido o un monto que no sea cadena decimal responde `400 invalid_request` (con `issues`, lista de `path` y `message`).

| Campo | Regla |
|---|---|
| `version` | **Obligatorio.** Entero: la `version` que usted leyó (bloqueo optimista; no hay `If-Match`) |
| `confirm` | Opcional. `true` confirma el documento |
| `reviewed_fields` | Opcional. Hasta 8 nombres de los campos con confianza (`issuer_ruc`, `issuer_legal_name`, `issued_on`, `document_number`, `receiver_ruc`, `payment_condition`, `totals`, `items`) que usted verificó contra el original y deja tal como se extrajeron. Otro nombre responde `422 invalid_correction`. Ver [correcciones por campo](#correcciones-por-campo-y-confianza-baja) |
| `document_type`, `timbrado`, `series`, `establishment_code`, `expedition_point_code`, `document_sequence`, `issued_on` (`YYYY-MM-DD`), `currency`, `exchange_rate` | Opcionales |
| `issuer` | `ruc`, `legal_name`, `trade_name`, `address`, `economic_activity` |
| `receiver` | `ruc`, `legal_name`, `type` |
| `payment` | `condition` (`cash` o `credit`), `credit_term_days`, `method`, `due_on`, `paid_on` |
| `totals` | `exempt`, `zero_rated`, `taxable_5`, `taxable_10`, `vat_5`, `vat_10`, `total_vat`, `discount`, `total_amount`, `total_pyg` (cadenas decimales) |
| `items` | Hasta 999. Ver [ítems](#eliminar-ítems) |

Un campo ausente conserva su valor; `null` lo borra (si admite nulo). El `cdc` no se puede corregir. Las cadenas decimales son de hasta 15 enteros y 8 decimales (`"110000"`, `"1.5"`).

### Eliminar ítems

Los ítems se identifican por `position`, un entero que **elige usted** y que nunca se reutiliza:

| Caso | Efecto |
|---|---|
| `position` activa | Modifica ese ítem |
| `position` nueva | Agrega un ítem |
| `"remove": true` | Elimina el ítem de forma lógica: la fila se conserva para la auditoría y `GET` no la lista |

Un ítem eliminado queda congelado: no se puede modificar ni volver a agregar con esa `position` (`422 invalid_correction`). Eliminar una `position` que no existe también es `422 invalid_correction`; eliminar una ya eliminada no hace nada. No hay `DELETE`.

### Validación atómica

Con `confirm: true`, o cuando el documento ya está `confirmed`, el resultado se **revalida**. Si falla, la petición completa se rechaza con `422 validation_failed` y la lista `reasons`, y **no se guarda nada**, ni siquiera las correcciones. Corrija todo y reintente.

Sin `confirm`, un documento en `needs_review` sigue en `needs_review`, su `version` aumenta y `needs_review_reasons` se recalcula (`awaiting_confirmation` si los datos ya son válidos).

### Correcciones por campo y confianza baja

Los documentos de PDF y foto guardan una confianza por cada uno de los 8 campos curados (`field_confidences[]`). Cada vez que un `PATCH` cambia un campo, su fila registra `corrected_value`, `corrected_by` (la API key) y `corrected_at`, en la misma transacción que los datos. Los campos que no son de los 8 (por ejemplo `issuer.trade_name`) se corrigen pero no tienen fila de confianza. Con `reviewed_fields` se registra lo mismo para un campo que usted comprobó y no cambia; `corrected_value` guarda entonces el valor que se verificó (`totals` guarda todos los montos; `items`, las posiciones activas). Un campo ya corregido o revisado no se registra de nuevo, y uno sin fila de confianza se ignora. En un documento `confirmed`, `reviewed_fields` se valida pero se ignora: una petición que solo trae `reviewed_fields` no cambia la versión, no registra corrector y no emite `reception.document.updated`.

Qué ocurre con los motivos que solo existen en la extracción cuando el `PATCH` **no** confirma:

- `low_confidence` se mantiene mientras quede algún campo con confianza menor que el umbral (`RECEPTION_AUTO_CONFIRM_THRESHOLD`) sin corregir ni revisar. Se retira cuando todos los campos bajo el umbral tienen `corrected_at`. Si ningún campo individual está bajo el umbral (la confianza baja es solo la global), no hay nada que corregir y solo `confirm: true` lo retira.
- `items_without_subtotals` se retira en cuanto un ítem activo trae `subtotal` (o ya no quedan ítems).
- Los motivos de validación se recalculan siempre con los datos corregidos.

`confirm: true` ignora `low_confidence` e `items_without_subtotals`: quien confirma asume la revisión, siempre que las validaciones pasen (si fallan, `422 validation_failed` y no se guarda nada).

### Versión e idempotencia

- Si la `version` enviada no es la actual: `409 version_conflict` con `current_version`. Vuelva a leer, reaplique sus cambios y reintente.
- Repetir una petición **ya aplicada** es seguro: si su efecto ya está en los datos guardados y la `version` enviada es la anterior (mismo actor), responde `200` con `Idempotent-Replayed: true`, sin subir la versión, sin auditoría y sin eventos. Si el efecto ya está con la versión actual, responde `200` sin escribir nada.
- Los montos se comparan por valor (`"10.50"` equivale a `"10.5"`).

### Respuesta

`200` con la misma forma que `GET /v1/received-documents/{id}`. El `version` de esa respuesta es el que usa para [ignorar su propio eco](#ignorar-el-eco-de-sus-cambios).

## Reprocesar

`POST /v1/received-documents/{id}/reprocess` (scope `reception:write`, sin cuerpo) vuelve a correr la extracción sobre el archivo **ya guardado**; no hay que volver a subirlo. Sirve cuando la extracción falló por algo ya resuelto (por ejemplo `llm_disabled` porque aún no había clave del modelo, o `internal_error`), o cuando la subida quedó sin encolar (`503 queue_unavailable`). También permite volver a leer un PDF o foto ya revisado o confirmado (por ejemplo con un modelo mejor), conservando las correcciones humanas.

| Documento | Resultado |
|---|---|
| PDF o foto en `received` o `extraction_failed` | `202` con `Location`: el trabajo queda en cola y el resultado llega después (`GET` o webhooks, como en una subida nueva). Para no dejar dos trabajos vivos, un `received` de menos de `RECEPTION_EXTRACTION_STALE_AFTER_MS` (su trabajo de subida puede seguir en cola) y un `extraction_failed` con código reintentable (`llm_provider_error`, `llm_rate_limited`, `internal_error`) de menos de 5 minutos (la cola aún puede reintentarlo) responden `202` sin hacer nada; un fallo definitivo (por ejemplo `llm_disabled`) se encola de inmediato. Si el pedido es inmediato tras un `503 queue_unavailable`, vuelva a subir los mismos bytes: eso sí reencola sin esperar. |
| PDF o foto en `extracting` | `202` sin hacer nada mientras la corrida sigue viva. Si lleva más de `RECEPTION_EXTRACTION_STALE_AFTER_MS` (30 minutos por defecto) sin cambios, se la toma por trabada: pasa a `extraction_failed` sin webhook y se encola de nuevo. |
| XML de SIFEN en `extraction_failed` | Se vuelve a leer **dentro de la petición**: `200` con el estado nuevo (`confirmed` o `needs_review`), o `422 extraction_failed` si sigue ilegible. |
| PDF o foto en `needs_review` o `confirmed` | `202` con `Location`: el trabajo queda en cola, el worker lleva el documento de vuelta a `extracting` (la versión sube) y lo reextrae **conservando las correcciones humanas** (ver abajo). Mientras el worker no lo reclama, el documento sigue como estaba. |
| XML de SIFEN en `needs_review` o `confirmed` | `409 invalid_state` con `status`: los mismos bytes no pueden leerse distinto. |

### Qué conserva la reextracción

Un campo con corrección o revisión humana (`corrected_at` en su confianza, ver *Correcciones por campo y confianza baja*) **no se sobrescribe**:

- Un campo curado corregido conserva su valor en el documento y su `corrected_value`, `corrected_by` y `corrected_at`. Solo se refrescan su `extracted_value` y su `confidence` (lo que el modelo lee ahora). Los campos que agrupa: RUC del emisor (base y DV), nombre del emisor, fecha, número de documento (establecimiento, punto y número), RUC del receptor, condición de pago y todos los totales.
- Los campos sin corrección toman la lectura nueva, con su confianza.
- Si los ítems están corregidos, se quedan exactamente como la persona los dejó (editados, agregados o quitados) y los ítems nuevos del modelo se descartan; si no, la lectura nueva reemplaza a los ítems activos.
- Lo que está fuera de los ocho campos curados (datos crudos, código de error) sale siempre de la lectura nueva. Un CDC que el modelo no lee no borra el CDC guardado.
- El resultado (`confirmed` o `needs_review`) se decide sobre los datos ya mezclados: validaciones, campos del emisor y artículos sin subtotal se evalúan con los valores humanos. La confianza global es la de la lectura nueva: si queda bajo el umbral, el documento vuelve a `needs_review` con `low_confidence` y se confirma con `confirm: true`.
- La entrada de auditoría `received_document.reprocess_requested` lista en `preservedCorrections` los campos cuyas correcciones se conservan.

Eventos: un documento que ya estuvo `confirmed` y se confirma otra vez tras reprocesar emite `reception.document.updated` con `actor` `system` (nunca un segundo `confirmed`); si queda en revisión emite `reception.document.needs_review`; un fallo, `reception.document.extraction_failed`. `confirmed_at` conserva la primera confirmación.

Un doble clic es seguro: el segundo pedido mientras el trabajo está en cola responde `202`, no crea otro trabajo, no consume otro cupo y no agrega otra entrada de auditoría (con el tope diario agotado el segundo pedido responde `429 extraction_quota_exceeded`). Un reproceso que encola un PDF o foto consume un cupo del [tope diario](#tope-diario-de-extracciones); la relectura del XML no. Cada pedido aceptado que hizo trabajo (un trabajo nuevo, o la relectura del XML) deja una entrada de auditoría (`received_document.reprocess_requested` o `received_document.reprocessed`). La versión del documento sube cuando el worker lo reclama, como en cualquier extracción. Errores: `404 not_found` (también de otro tenant), `429 extraction_quota_exceeded` (con `Retry-After`), `409 artifact_not_available` (sin archivo guardado, o el archivo ya no está en el almacenamiento), `503 queue_unavailable` y `503 storage_unavailable` (cualquier falla del almacenamiento).

## Eventos de webhook

Registre un endpoint con `POST /v1/webhooks/endpoints` (`url` y `events`, scope `webhooks:write`). La firma, los reintentos y el formato del sobre son los de [`webhooks.md`](webhooks.md). Los eventos de recepción:

| Evento | Cuándo |
|---|---|
| `reception.document.needs_review` | El documento queda en `needs_review` y el ERP debe corregirlo. Lleva `reasons` |
| `reception.document.confirmed` | El documento pasa a `confirmed` (al subirlo o por `PATCH` con `confirm`) |
| `reception.document.extraction_failed` | No se pudo leer el archivo subido |
| `reception.document.updated` | Se edita un documento ya `confirmed`, o se lo confirma otra vez tras reprocesarlo. Lleva `actor` |

La carga trae identificadores, estado, versión y un enlace, **nunca datos fiscales**: léalos con `GET`.

### Contrato del eco

`data.version` es la versión **posterior** al cambio y `data.status` el estado resultante. Para `updated`, `data.actor` dice quién lo hizo: `{ "type": "api_key", "id": "<id de la API key>" }`, `{ "type": "portal" }` o `{ "type": "system" }`. Hoy el actor de un `PATCH` es la API key; la reextracción confirmada otra vez es del `system`.

#### Ignorar el eco de sus cambios

`reception.document.updated` se emite **siempre**, también hacia el endpoint del propio ERP que hizo el `PATCH`. Para no procesar su eco, descarte el evento si:

1. `data.actor.type == "api_key"` y `data.actor.id` es el id de la API key con la que hizo el `PATCH`; y
2. `data.version` es igual al `version` que devolvió ese `PATCH`.

En cualquier otro caso (otra API key, `portal`, `system` u otra versión) el cambio no es suyo y debe procesarlo. El evento `confirmed` no lleva `actor`: reconozca el suyo comparando `data.version` con el `version` de la respuesta del `PATCH` que confirmó. Ejemplo completo y carga del evento en [`webhooks.md`](webhooks.md#ignorar-el-eco-de-los-cambios-propios).

## Ejemplo completo

Subir un XML, esperar el webhook `needs_review`, corregir y confirmar.

```bash
# 1. Subir. Responde 202 y deja el documento en needs_review (los totales no cierran)
curl -i -X POST "$BASE_URL/v1/received-documents" \
  -H "Authorization: Bearer $SIFEN_API_KEY" \
  -H "Content-Type: application/xml" \
  --data-binary @factura-proveedor.xml
```

```http
HTTP/1.1 202 Accepted
Location: /v1/received-documents/5b3f0f4e-7a49-4b61-9a5e-3a1f2c9d8e10

{ "id": "5b3f0f4e-7a49-4b61-9a5e-3a1f2c9d8e10", "status": "needs_review", "version": 1, "source": "sifen_xml" }
```

Paso 2: su endpoint de webhooks recibe `reception.document.needs_review` con `data.reasons: ["totals_blocks_sum_mismatch"]` y `data.version: 1`. Verifique la firma y deduplique por `id`, como indica [`webhooks.md`](webhooks.md).

```bash
# 3. Leer el documento para mostrarlo o decidir la corrección
curl "$BASE_URL/v1/received-documents/5b3f0f4e-7a49-4b61-9a5e-3a1f2c9d8e10" \
  -H "Authorization: Bearer $SIFEN_API_KEY"

# 4. Corregir y confirmar en una sola llamada, con la version leída
curl -X PATCH "$BASE_URL/v1/received-documents/5b3f0f4e-7a49-4b61-9a5e-3a1f2c9d8e10" \
  -H "Authorization: Bearer $SIFEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "version": 1,
    "confirm": true,
    "totals": { "taxable_10": "100000", "vat_10": "10000", "total_vat": "10000", "total_amount": "110000" },
    "items": [{ "position": 2, "remove": true }]
  }'
```

El `PATCH` responde `200` con el documento en `status: "confirmed"` y `version: 2`. Llega `reception.document.confirmed` con `data.version: 2`, que es el eco de este mismo cambio y se descarta. Si en cambio `confirm: true` no pasa la validación, responde `422`:

```json
{
  "statusCode": 422,
  "code": "validation_failed",
  "message": "The corrected document does not pass validation; nothing was saved",
  "reasons": ["totals_blocks_sum_mismatch"]
}
```

## Errores

Todos los errores usan `{ "statusCode", "code", "message" }` más campos extra según el caso.

| HTTP | `code` | Cuándo | Qué hacer |
|---|---|---|---|
| `400` | `invalid_request` | `id` que no es UUID, parámetro de `GET` mal formado, o cuerpo de `PATCH` inválido (con `issues`) | Corregir la petición |
| `401` | n/a | API key ausente o inválida | Revisar la clave |
| `403` | n/a | La key no tiene el scope de la ruta | Pedir el scope al operador |
| `404` | `not_found` | El documento no existe, es de otro tenant, o (en artefacto) no tiene archivo | Verificar el id |
| `409` | `version_conflict` | La `version` enviada no es la actual. Trae `current_version` | Releer y reintentar |
| `409` | `invalid_state` | `PATCH` sobre un documento que no está en `needs_review` ni `confirmed`, o reproceso de uno que está en `needs_review` o `confirmed`. Trae `status` | No reintentar igual |
| `409` | `artifact_not_available` | Reproceso de un documento sin archivo guardado, o cuyo archivo ya no está en el almacenamiento | Subir el archivo de nuevo |
| `413` | `payload_too_large` | El archivo supera `RECEPTION_MAX_UPLOAD_BYTES` | Enviar un archivo menor |
| `415` | `unsupported_media_type` | Los bytes no son XML de SIFEN, PDF, PNG ni JPEG | Enviar un archivo soportado |
| `422` | `unsupported_source` | Solo CDC (`{ "cdc": ... }`): aún no se procesa. Cualquier otro contenido que no sea XML de SIFEN, PDF, PNG ni JPEG responde `415` | Enviar el archivo |
| `422` | `empty_upload` | Archivo vacío | Enviar el archivo |
| `422` | `invalid_request` | Falta la parte `file` en `multipart`, o el JSON no trae un `xml` de tipo cadena | Corregir la petición |
| `422` | `extraction_failed` | El XML no se pudo leer como documento SIFEN soportado. Trae `document_id` (el archivo queda guardado) | Revisar el archivo; luego [reprocesar](#reprocesar) o subir uno corregido |
| `422` | `validation_failed` | `PATCH` revalidado falló. Trae `reasons`; no se guardó nada | Corregir los motivos |
| `422` | `invalid_correction` | `position` desconocida, editar o re-agregar un ítem eliminado, o un nombre de `reviewed_fields` que no es uno de los 8 campos | Corregir la petición |
| `429` | `extraction_quota_exceeded` | El tenant agotó su tope diario de extracciones (`RECEPTION_EXTRACTION_DAILY_CAP`). Trae `cap`, `retry_after_seconds` y el encabezado `Retry-After` | Esperar al próximo día UTC o pedir que suban el tope |
| `503` | `storage_unavailable` | El almacenamiento de objetos no está configurado o no responde | Avisar al operador |
| `503` | `queue_unavailable` | PDF o foto: la cola de extracción no está disponible. En la subida trae `document_id` y el archivo quedó guardado | Reintentar la misma subida, o el reproceso, más tarde |
| `503` | `service_unavailable` | La recepción no está disponible (sin base de datos) | Reintentar; avisar al operador |

## Privacidad

El XML de SIFEN se procesa dentro de la plataforma. Al extraer **PDF y fotos**, las imágenes de las facturas se envían a un modelo de un tercero (Anthropic) para extraer los datos ([ADR-0026](../adr/0026-pipeline-de-extraccion-confianza-y-auto-confirmacion.md), punto 7). Antes de habilitarlo en producción (`ANTHROPIC_API_KEY`) hace falta la decisión del dueño del producto sobre datos personales y fiscales y el acuerdo de tratamiento de datos; sin la clave, los PDF y fotos terminan en `extraction_failed` con `llm_disabled`.

## Alcance actual y límites conocidos

- XML de SIFEN, PDF y fotos (PNG, JPEG). La consulta por CDC está planificada (`422 unsupported_source`).
- El reproceso no admite `needs_review` ni `confirmed`: volver a extraer un documento ya revisado exige un cambio de la máquina de estados que está pendiente de decisión. Mientras tanto se corrige con `PATCH`.
- El portal es de solo lectura: no sube, corrige ni confirma. Expone `GET /portal/received-documents` y `GET /portal/received-documents/{id}` con la sesión del portal (mismas formas que `/v1`, sin escrituras); no forman parte del contrato público (`openapi.json`). Hoy tampoco genera eventos `portal` ni `system`.
- La recepción se integra solo por API. El portal no tiene páginas de API keys ni de webhooks: los endpoints de webhook (que reciben los eventos `reception.document.*`) se gestionan con `/v1/webhooks/endpoints`, y una pantalla de ajustes para ambos es una funcionalidad futura.
- El `POST` no usa `Idempotency-Key`; la deduplicación es por contenido y por CDC.
- No hay `DELETE`: los ítems se eliminan de forma lógica y el documento no se elimina.
- Los eventos se emiten una vez por documento, tipo y versión, y se entregan al menos una vez: deduplique por `id`.
- Los documentos con `is_own_receiver = false` no generan eventos.
