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

Hoy **solo se procesa el XML de SIFEN** (`rDE`). El resto de las fuentes llega en fases posteriores y responde `422` con `code: "unsupported_source"`:

| Fuente | Estado |
|---|---|
| XML de SIFEN (cuerpo crudo, `multipart` o JSON `{ "xml": ... }`) | Disponible |
| PDF y fotos (JPEG, PNG) | Planificado. Hoy `422 unsupported_source` |
| Solo el CDC (`{ "cdc": "..." }`, consulta a eKuatia) | Planificado. Hoy `422 unsupported_source` |
| Reprocesar un documento en `extraction_failed` | Planificado. No hay ruta en la API todavía |

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

Con el XML de SIFEN la lectura ocurre **dentro de la petición**: la respuesta `202` ya trae el estado final, que es `confirmed` si el documento pasa la validación o `needs_review` si no. Los estados `received`, `extracting` y `extracted` solo se verán cuando se procesen PDF y fotos de forma asíncrona. Un documento en `extraction_failed` se rechaza con `422` al subirlo (ver [errores](#errores)), pero queda guardado y se puede consultar con `GET`.

Cada documento tiene un número de `version` que empieza en 1. Sube al confirmarse y con cada edición posterior. Es lo que espera `PATCH`.

## Subir un documento

`POST /v1/received-documents` (scope `reception:write`). Tres formas de enviar el XML:

| Forma | Encabezado | Cuerpo |
|---|---|---|
| Cuerpo crudo | `Content-Type: application/xml` o `text/xml` | El XML |
| Multipart | `Content-Type: multipart/form-data` | Una parte `file` (se guarda el nombre original) |
| JSON | `Content-Type: application/json` | `{ "xml": "<rDE ...>" }` (tope de 1 MiB) |

El contenido se reconoce por sus **primeros bytes**, no por el tipo declarado: un `Content-Type: application/xml` con un PDF dentro responde `422 unsupported_source`; con bytes que no son XML, `415`.

| Respuesta | Cuándo | Cuerpo |
|---|---|---|
| `202` | Documento nuevo. Incluye `Location: /v1/received-documents/{id}` | `{ "id", "status", "version", "source" }` |
| `200` | Ya se había recibido (mismos bytes o mismo CDC). Incluye `Location` | Lo mismo, del documento existente |
| `4xx` / `503` | Ver [errores](#errores) | `{ "statusCode", "code", "message" }` |

El cuerpo de la respuesta es solo un acuse. Los datos fiscales se leen con `GET`.

### Duplicados

- **Mismo contenido** (sha256 de los bytes): responde `200` con el documento existente, sin crear nada ni emitir eventos.
- **Mismo CDC** con bytes distintos (por ejemplo, el XML reenviado con otra firma): responde `200` con el documento que ya existía y se descarta el archivo nuevo.
- Para todo lo demás, el `POST` no usa `Idempotency-Key`: la idempotencia es natural, por contenido y por CDC. Reintentar una subida es seguro.

### Tamaño máximo

Por defecto 2 MiB por archivo. Lo cambia el operador con `RECEPTION_MAX_UPLOAD_BYTES` (entre 1 byte y 15 MiB), ver [`configuracion.md`](../configuracion.md). Lo que lo supera responde `413 payload_too_large`.

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

### Versión e idempotencia

- Si la `version` enviada no es la actual: `409 version_conflict` con `current_version`. Vuelva a leer, reaplique sus cambios y reintente.
- Repetir una petición **ya aplicada** es seguro: si su efecto ya está en los datos guardados y la `version` enviada es la anterior (mismo actor), responde `200` con `Idempotent-Replayed: true`, sin subir la versión, sin auditoría y sin eventos. Si el efecto ya está con la versión actual, responde `200` sin escribir nada.
- Los montos se comparan por valor (`"10.50"` equivale a `"10.5"`).

### Respuesta

`200` con la misma forma que `GET /v1/received-documents/{id}`. El `version` de esa respuesta es el que usa para [ignorar su propio eco](#ignorar-el-eco-de-sus-cambios).

## Eventos de webhook

Registre un endpoint con `POST /v1/webhooks/endpoints` (`url` y `events`, scope `webhooks:write`). La firma, los reintentos y el formato del sobre son los de [`webhooks.md`](webhooks.md). Los eventos de recepción:

| Evento | Cuándo |
|---|---|
| `reception.document.needs_review` | El documento queda en `needs_review` y el ERP debe corregirlo. Lleva `reasons` |
| `reception.document.confirmed` | El documento pasa a `confirmed` (al subirlo o por `PATCH` con `confirm`) |
| `reception.document.extraction_failed` | No se pudo leer el archivo subido |
| `reception.document.updated` | Se edita un documento ya `confirmed`. Lleva `actor` |

La carga trae identificadores, estado, versión y un enlace, **nunca datos fiscales**: léalos con `GET`.

### Contrato del eco

`data.version` es la versión **posterior** al cambio y `data.status` el estado resultante. Para `updated`, `data.actor` dice quién lo hizo: `{ "type": "api_key", "id": "<id de la API key>" }`, `{ "type": "portal" }` o `{ "type": "system" }`. Hoy el único actor que produce eventos es la API key.

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
| `409` | `invalid_state` | `PATCH` sobre un documento que no está en `needs_review` ni `confirmed`. Trae `status` | No reintentar igual |
| `413` | `payload_too_large` | El archivo supera `RECEPTION_MAX_UPLOAD_BYTES` | Enviar un archivo menor |
| `415` | `unsupported_media_type` | Los bytes no son XML (ni PDF ni imagen) | Enviar un XML de SIFEN |
| `422` | `unsupported_source` | PDF, foto o solo CDC: aún no se procesan | Esperar la fase correspondiente |
| `422` | `empty_upload` | Archivo vacío | Enviar el archivo |
| `422` | `invalid_request` | Falta la parte `file` en `multipart`, o el JSON no trae un `xml` de tipo cadena | Corregir la petición |
| `422` | `extraction_failed` | El XML no se pudo leer como documento SIFEN soportado. Trae `document_id` (el archivo queda guardado) | Revisar el archivo; no hay reproceso por API todavía |
| `422` | `validation_failed` | `PATCH` revalidado falló. Trae `reasons`; no se guardó nada | Corregir los motivos |
| `422` | `invalid_correction` | `position` desconocida, o editar o re-agregar un ítem eliminado | Corregir los ítems |
| `503` | `storage_unavailable` | El almacenamiento de objetos no está configurado o no responde | Avisar al operador |
| `503` | `service_unavailable` | La recepción no está disponible (sin base de datos) | Reintentar; avisar al operador |

## Privacidad

Hoy solo se lee el XML de SIFEN, que se procesa dentro de la plataforma. Cuando se habilite la extracción de **PDF y fotos** (planificado), las imágenes de las facturas se enviarán a un modelo de un tercero (Anthropic) para extraer los datos ([ADR-0026](../adr/0026-pipeline-de-extraccion-confianza-y-auto-confirmacion.md), punto 7). Antes de habilitarlo hace falta la decisión del dueño del producto sobre datos personales y fiscales y el acuerdo de tratamiento de datos. Esta guía se actualizará entonces.

## Alcance actual y límites conocidos

- Solo XML de SIFEN. PDF, fotos y consulta por CDC están planificados (`422 unsupported_source`).
- No hay ruta para reprocesar un documento en `extraction_failed`.
- El portal es de solo lectura: no sube, corrige ni confirma. Hoy tampoco genera eventos `portal` ni `system`.
- El `POST` no usa `Idempotency-Key`; la deduplicación es por contenido y por CDC.
- No hay `DELETE`: los ítems se eliminan de forma lógica y el documento no se elimina.
- Los eventos se emiten una vez por documento, tipo y versión, y se entregan al menos una vez: deduplique por `id`.
- Los documentos con `is_own_receiver = false` no generan eventos.
