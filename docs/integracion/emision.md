# Guía de integración: emisión de facturas

Referencia para integradores que emiten facturas electrónicas (FE) con `POST /v1/documents`. El contrato máquina-legible es [`docs/api/openapi.json`](../api/openapi.json); los eventos de resultado están en [`webhooks.md`](webhooks.md). Decisión: [ADR-0011](../adr/0011-api-asincrona-202-webhooks-idempotencia.md).

## Qué hace la plataforma y qué hace usted

| Responsable | Tareas |
|---|---|
| Contribuyente (fuera de la plataforma) | Tramita ante la DNIT el RUC, la habilitación como facturador (timbrado, establecimientos, puntos de expedición, CSC) y el certificado `.p12` |
| Operador de la plataforma | Carga esa configuración fiscal, el certificado y las API keys del tenant |
| Plataforma | Valida, numera, genera el CDC, firma, transmite a SIFEN, genera el KuDE y notifica por webhook |
| Su sistema | Envía los datos comerciales del documento y consume el resultado |

Su sistema **no envía** datos del emisor, timbrado, número, CDC, firma ni fecha de emisión: salen de la configuración fiscal del tenant y los fija la plataforma. El número se asigna en forma secuencial al aceptar el documento.

## Autenticación y ambientes

```http
Authorization: Bearer sk_test_...
Idempotency-Key: <valor único por documento>
```

- Las API keys `sk_test_...` y `sk_live_...` identifican el ambiente. Cada instancia de la plataforma acepta solo el prefijo de su ambiente (`SIFEN_ENVIRONMENT`).
- La URL base de cada ambiente la entrega el operador al dar de alta el tenant.
- Los scopes necesarios son `documents:write` para emitir y `documents:read` para consultar.

## Emitir una factura

`POST /v1/documents` con cuerpo JSON. Responde `202` cuando el documento quedó persistido con su CDC; la firma y la transmisión a SIFEN son asíncronas.

### Campos

| Campo | Tipo | Regla |
|---|---|---|
| `establishment` | string | 3 dígitos. Establecimiento configurado del tenant |
| `expeditionPoint` | string | 3 dígitos. Punto de expedición configurado en ese establecimiento |
| `operationType` | string | `B2B`, `B2C`, `B2G` o `B2F`. Hoy solo `B2B` y `B2C` se aceptan: `B2G` y `B2F` responden `422` con `rule: "operation-type-not-supported"` (diferidos por producto) |
| `receiver` | objeto | Ver [Receptor](#receptor) |
| `items` | array | De 1 a 999 ítems. Ver [Ítems](#ítems) |
| `roundingPyg` | entero | De 0 a 49. Por defecto 0. Ver [Montos y redondeo](#montos-y-redondeo) |
| `location.departmentCode` | entero | Opcional. Departamento **del receptor**, de la tabla de [códigos geográficos](#códigos-geográficos). Obligatorio cuando el receptor informa dirección, salvo en `B2F`, donde no debe informarse. Con un receptor innominado no se usa en el XML, pero debe seguir siendo un código válido (uno inválido responde `422` con `department-code`) |
| `currency` | string | Solo `PYG`. Por defecto `PYG` |

### Receptor

Receptor identificado (`kind: "named"`):

| Campo | Regla |
|---|---|
| `ruc` | RUC con dígito verificador, formato `base-DV` |
| `isPublicEntity` | Booleano, por defecto `false`. Si es `true`, SIFEN exige `B2G` (`public-entity-requires-b2g`, 1332), que hoy no está soportado: un receptor entidad pública no se puede facturar todavía |
| `name` | De 4 a 255 caracteres |
| `address` | Opcional, hasta 255 caracteres. El bloque de dirección es todo o nada: `houseNumber`, `districtCode`, `cityCode` y `location.departmentCode` no se aceptan sin `address`. Obligatorio con `B2F` (`receiver-address-required`) |
| `houseNumber` | Texto de 1 a 6 dígitos. Obligatorio si hay `address` (`receiver-house-number-required`) |
| `districtCode` / `districtDescription` | Opcionales, siempre juntos. Código entero de 1 a 9999 y descripción de hasta 30 caracteres |
| `cityCode` / `cityDescription` | Siempre juntos. Código entero de 1 a 99999 y descripción de hasta 30 caracteres. Con `address` son obligatorios salvo en `B2F`, donde no deben informarse (`receiver-city-required`, `receiver-city-not-allowed`) |
| `email` | Opcional. Una sola dirección simple (`usuario@dominio.tld`) de 3 a 80 caracteres, con el patrón `tEmail` de SIFEN; no se aceptan listas ni nombres (`Juan <a@b.com>`). Va en el XML como `dEmailRec` y es el destino del correo con el KuDE y el XML firmado (ver [Correo al receptor](#correo-al-receptor)). Las notas de crédito y débito usan el correo de la factura |

`B2F` hoy se rechaza por completo (`operation-type-not-supported`, decisión de producto); las reglas siguientes quedan fijadas para cuando se habilite. Con `B2F` se rechaza `location.departmentCode` (`receiver-department-not-allowed`) y `cityCode`. Con otra operación y `address`, el departamento es obligatorio (`receiver-department-required`).

Receptor innominado (`kind: "unnamed"`): no lleva `ruc` ni `name`. Se rechaza si el total neto es de 7.000.000 Gs o más.

### Códigos geográficos

| Dato | Qué valida la plataforma | Qué debe hacer su sistema |
|---|---|---|
| `location.departmentCode` | Debe estar en la tabla de departamentos de SIFEN (`Departamentos_v141.xsd`); si no, responde `422` con `rule: "department-code"`. La descripción la completa la plataforma | Enviar el código del departamento del receptor cuando informe dirección (no en `B2F`) |
| `receiver.districtCode` y `receiver.cityCode` | Deben existir en la tabla oficial de la DNIT (Tabla 2.1, `GET /v1/geo/*`), la ciudad debe pertenecer al distrito y el distrito al departamento; si no, `422` con `receiver-district-unknown`, `receiver-city-unknown`, `receiver-city-not-in-district`, `receiver-district-not-in-department` o `receiver-city-not-in-department` | Enviar los códigos tal como los devuelven los endpoints de geografía |
| `districtDescription` y `cityDescription` | Deben ser la descripción de la tabla para su código (`receiver-district-description-mismatch`, SIFEN 1325; `receiver-city-description-mismatch`, SIFEN 1329). Se comparan sin distinguir mayúsculas, acentos ni espacios repetidos: `Asunción` equivale a `ASUNCION`. El XML siempre lleva el texto oficial de la tabla | Enviar la descripción oficial, o el texto equivalente |

Desde el día anterior al vencimiento del certificado de firma del tenant (`CERTIFICATE_EMISSION_BLOCK_DAYS`, ver [configuración](../configuracion.md)) la emisión responde `422` con `code: "certificate_expiring"` y `notAfter` (UTC), sin consumir un número. Antes se avisa con el webhook `certificate.expiring` a 60, 30 y 7 días. Subir un certificado renovado (`certificate:add --replace`) levanta el bloqueo. Reintentar con la misma `Idempotency-Key` un documento ya aceptado devuelve el original aunque el certificado esté por vencer.

Un código de distrito o ciudad inexistente o que no encaje en la jerarquía, o una descripción que no corresponda, se rechazan con `422` antes de consumir un número (reglas de la tabla anterior). El departamento del emisor no se envía: sale del establecimiento configurado.

La tabla geográfica oficial de la DNIT (basada en el código geográfico del INE 2022) tiene 18 departamentos. Los códigos 19 (Chaco) y 20 (Nueva Asunción) son entradas históricas de `Departamentos_v141.xsd` sin distritos ni ciudades: una dirección de receptor en esos departamentos no se puede validar y responde `422`, y `GET /v1/geo/districts?departmentCode=19` responde `404`.

Departamentos (`cDepEmi`): 1 Capital, 2 Concepción, 3 San Pedro, 4 Cordillera, 5 Guairá, 6 Caaguazú, 7 Caazapá, 8 Itapúa, 9 Misiones, 10 Paraguarí, 11 Alto Paraná, 12 Central, 13 Ñeembucú, 14 Amambay, 15 Presidente Hayes, 16 Boquerón, 17 Alto Paraguay, 18 Canindeyú, 19 Chaco, 20 Nueva Asunción.

### Consultar los códigos geográficos

Los códigos y descripciones válidos salen de la tabla oficial de la DNIT (Tabla 2.1) y se consultan con una API key válida, sin scope adicional. Cada lista se filtra por el padre; ningún endpoint devuelve la tabla completa de ciudades.

| Ruta | Devuelve | Errores |
|---|---|---|
| `GET /v1/geo/departments` | Los 18 departamentos | `401` |
| `GET /v1/geo/districts?departmentCode=11` | Los distritos de un departamento | `400` si falta o no es un código; `404` si no existe |
| `GET /v1/geo/cities?districtCode=145` | Las ciudades de un distrito | `400` si falta o no es un código; `404` si no existe |

```bash
curl -s 'https://api.example.com/v1/geo/cities?districtCode=145' -H 'Authorization: Bearer sk_live_...'
```

```json
{ "items": [{ "code": 3383, "districtCode": 145, "name": "CIUDAD DEL ESTE" }] }
```

La respuesta real trae todas las ciudades del distrito; arriba se muestra una.

Los registros llevan el departamento (`departmentCode`) en los distritos y el distrito (`districtCode`) en las ciudades. El campo `name` es el texto que va en `districtDescription` y `cityDescription`.

### Ítems

| Campo | Regla |
|---|---|
| `code` | Texto de 1 a 50 caracteres. Lo define el integrador (por ejemplo, su SKU o id interno) |
| `description` | Texto de 1 a 2000 caracteres |
| `unitCode` | Código de la lista cerrada de unidades de medida (cUniMed). `77` = Unidad, `87` = Metros, `83` = Kilogramos |
| `quantity` | Número mayor que 0. Admite decimales |
| `unitPrice` | Entero en PYG, **con IVA incluido**, mayor o igual a 0 |
| `vatRate` | Obligatorio: `0`, `5` o `10`. No hay valor por defecto |

El tratamiento de `vatRate: 0` es **exento** (IVA tipo 3). Hoy no se soportan ítems exonerados ni de gravado parcial.

### Montos y redondeo

La plataforma no suma IVA: el total del documento es `Σ quantity × unitPrice` y el monto a cobrar es `total − roundingPyg`.

1. Si su sistema guarda el precio sin IVA, calcule `unitPrice = round(precioNeto × (1 + vatRate / 100))` a entero antes de enviar.
2. `quantity × unitPrice` de cada ítem debe dar un **entero**. Si no, el documento se rechaza con `422` (`pyg-integer`); la plataforma no redondea líneas por usted.
3. `roundingPyg` es un entero de 0 a 49 tal que `total − roundingPyg` sea múltiplo de 50. Ejemplo: total `107437` → `roundingPyg: 37`.
4. Ningún ítem ni el total puede superar 999.999.999.999.999 Gs.

### Ejemplo

```bash
curl -X POST "$BASE_URL/v1/documents" \
  -H "Authorization: Bearer $SIFEN_API_KEY" \
  -H "Idempotency-Key: 6f1c2a9e-5d3b-4c7a-9e21-0b8f4a7d1c33" \
  -H "Content-Type: application/json" \
  -d '{
    "establishment": "001",
    "expeditionPoint": "001",
    "operationType": "B2B",
    "receiver": {
      "kind": "named",
      "ruc": "4490207-7",
      "name": "Cliente de Ejemplo",
      "address": "Avda. Siempre Viva",
      "houseNumber": "123",
      "districtCode": 145,
      "districtDescription": "Ciudad del Este",
      "cityCode": 3383,
      "cityDescription": "Ciudad del Este"
    },
    "items": [
      {
        "code": "CONSULTA-GRAL",
        "description": "Consulta veterinaria",
        "unitCode": 77,
        "quantity": 1,
        "unitPrice": 110000,
        "vatRate": 10
      },
      {
        "code": "VACUNA-ANTIRRABICA",
        "description": "Vacuna antirrábica",
        "unitCode": 77,
        "quantity": 1,
        "unitPrice": 25000,
        "vatRate": 0
      }
    ],
    "roundingPyg": 0,
    "location": { "departmentCode": 11 }
  }'
```

Respuesta `202`:

```json
{ "document_id": "b3b8c2d6-0c1e-4c38-a5b4-6f2f9a1b7e10", "cdc": "01800695631001001000000712026101310000000019" }
```

### Esperar el resultado (`?wait=true`)

Un tenant con la transmisión síncrona activada (la activa operaciones con `tenant:sync-transmission`) puede enviar `POST /v1/documents?wait=true`. La respuesta se retiene hasta que SIFEN resuelve el documento o vence `SYNC_WAIT_TIMEOUT_MS` (30 s por defecto, de 1 a 30 s): si el documento llegó a `approved`, `approved_with_observations` o `rejected`, responde `200` con el documento (mismo cuerpo que `GET /v1/documents/{id}`); si no, o si el tenant no tiene el flag, responde el `202` de siempre y el resultado llega por webhook. El `Idempotency-Key` sigue valiendo: un reintento devuelve el mismo documento.

El envío lo sigue haciendo el ciclo del worker (`TRANSMISSION_CYCLE_INTERVAL_MS`, 60 s por defecto): la espera solo observa el documento cada 500 ms. Para que `wait=true` alcance a resolverse dentro del plazo, el ciclo debe correr con un intervalo menor que `SYNC_WAIT_TIMEOUT_MS`.

## Emitir una nota de crédito

Una nota de crédito electrónica (NCE) acredita total o parcialmente una FE que usted ya emitió y que SIFEN **aprobó** (`approved` o `approved_with_observations`). Se envía al mismo `POST /v1/documents`, con `"type": "NCE"` y el mismo `Idempotency-Key`.

| Campo | Descripción |
|---|---|
| `type` | `"NCE"` |
| `establishment`, `expeditionPoint` | Como en la FE |
| `associatedCdc` | CDC (44 dígitos) de la FE que se acredita |
| `reasonCode` | Motivo, de 1 a 8: 1 Devolución y Ajuste de precios, 2 Devolución, 3 Descuento, 4 Bonificación, 5 Crédito incobrable, 6 Recupero de costo, 7 Recupero de gasto, 8 Ajuste de precio |
| `items`, `roundingPyg` | Como en la FE; la nota acredita el total neto de estos ítems |

No se envían `receiver`, `operationType` ni `location`: se toman de la FE asociada (enviarlos es un `422`). La suma de las notas de crédito de una FE no puede superar el total de la FE; una nota rechazada por SIFEN sigue contando (se reenvía con el mismo CDC), y solo una anulada (`cancelled`, `number_voided`) libera su crédito.

```json
{
  "type": "NCE",
  "establishment": "001",
  "expeditionPoint": "002",
  "associatedCdc": "01800695631001002000012312026010111234567891",
  "reasonCode": 2,
  "items": [
    { "code": "A-001", "description": "Devolución de servicio", "unitCode": 77, "quantity": 1, "unitPrice": 400000, "vatRate": 10 }
  ]
}
```

La respuesta es la misma, `202 { "document_id", "cdc" }`, con un CDC que empieza en `05` y numeración propia. Reglas que responden `422` (sin consumir número):

| `rule` | Código SIFEN | Causa |
|---|---|---|
| `associated-document-not-found` | 2403 | La FE no existe para su cuenta |
| `associated-document-cancelled` | 2404 | La FE está cancelada o su número inutilizado |
| `associated-document-not-invoice` | 2414 | El CDC no es de una FE |
| `associated-document-not-approved` | - | La FE existe pero SIFEN todavía no la aprobó |
| `associated-document-unreadable` | - | Los datos guardados de la FE no se pueden leer |
| `credit-note-sum-exceeds-invoice` | 2417 | La suma de créditos supera el total de la FE |
| `credit-note-currency-mismatch` | 2438 | Moneda distinta (hoy solo existe `PYG`) |
| `credit-note-unnamed-receiver` | 1331 | La FE se emitió a un receptor innominado: no se puede acreditar |
| `credit-note-reason` | 1452 | `reasonCode` fuera de 1 a 8 |

El KuDE de una NCE (`GET /v1/documents/{id}/kude`) lleva el título "KuDE de Nota de Crédito Electrónica", el motivo y la FE asociada.

## Emitir una nota de débito

Una nota de débito electrónica (NDE) aumenta el valor de una FE que usted ya emitió y que SIFEN **aprobó**. Se envía al mismo `POST /v1/documents` con `"type": "NDE"`, los mismos campos que la NCE y el mismo `Idempotency-Key`. `reasonCode` va de 1 a 8 (misma tabla que la NCE). Como el débito suma al valor de la FE, no existe tope de suma (la regla 2417 aplica solo a créditos).

La respuesta es `202 { "document_id", "cdc" }`, con un CDC que empieza en `06` y numeración propia. Las reglas `422` son las de la NCE salvo `credit-note-sum-exceeds-invoice`, y con prefijo `debit-note-` (`debit-note-currency-mismatch`, `debit-note-unnamed-receiver`, `debit-note-reason`). El KuDE (`GET /v1/documents/{id}/kude`) lleva el título "KuDE de Nota de Débito Electrónica", el motivo y la FE asociada.

## Emitir una autofactura

Una autofactura electrónica (AFE) documenta una compra a un vendedor que no es contribuyente (persona sin RUC, productor rural o extranjero). Usted, como emisor, es también el receptor. Se envía al mismo `POST /v1/documents` con `"type": "AFE"` y el mismo `Idempotency-Key`.

Campos propios: `seller` (`nature` 1 no contribuyente o 2 extranjero, `idType` 1 a 4, `idNumber` de 1 a 20 letras, números o guiones, `name`, y su dirección con `address`, `houseNumber`, `departmentCode`, `districtCode`, `cityCode`), `place` (dónde ocurrió la compra, mismo formato de dirección) y `certificate` (la constancia del vendedor: `type` 1 no contribuyente o 2 microproductor, `number` de 11 dígitos sin cero inicial y `control` de 8 caracteres). Los ítems llevan `code`, `description`, `unitCode`, `quantity` y `unitPrice`; no llevan IVA. No se envían `receiver` ni `operationType`: el receptor es el emisor, la operación es B2C y el pago es contado.

La respuesta es `202 { "document_id", "cdc" }`, con un CDC que empieza en `04` y numeración propia. Las reglas `422` llevan el prefijo `self-invoice-` (por ejemplo `self-invoice-certificate-number`). El KuDE (`GET /v1/documents/{id}/kude`) lleva el título "KuDE de Autofactura Electrónica", el vendedor, el lugar de la transacción y la constancia.

## Emitir una nota de remisión

Una nota de remisión electrónica (NRE) ampara el traslado de mercaderías. Se envía al mismo `POST /v1/documents` con `"type": "NRE"` y el mismo `Idempotency-Key`. No tiene importes, IVA ni totales.

Campos propios: `motive` (E501: 1 a 14 o 99), `responsible` (E503: 1 a 5), `km` (kilómetros estimados, 1 a 99999), `invoiceDate` (opcional, `AAAA-MM-DD`), `receiver` (`ruc`, `name` y su dirección completa; solo en los motivos 3 y 5, exportación e importación, el receptor puede ir sin `ruc`, con `idType` 1 a 4, `idNumber` y `countryCode` ISO alfa-3), `transport` (`type`, `modality`, `freightResponsible`, `startDate`, `endDate`, los lugares `departure` y `delivery`, el `vehicle` y el `carrier` con su `driver`) e `items` con `code`, `description`, `unitCode` y `quantity`; un `unitPrice` se rechaza. El motivo 7 (traslado entre locales) solo se acepta hacia el RUC del propio emisor (regla 2606).

La respuesta es `202 { "document_id", "cdc" }`, con un CDC que empieza en `07` y numeración propia. El KuDE (`GET /v1/documents/{id}/kude`) lleva el título "KuDE de Nota de Remisión Electrónica", el motivo, las fechas, los lugares, el vehículo y el transportista, sin precios ni totales.

## Idempotencia

`Idempotency-Key` es obligatorio. Reintentar con la **misma clave y el mismo cuerpo** devuelve la misma respuesta sin crear otro documento; la misma clave con otro cuerpo responde `409`. Genere una clave nueva por documento y reutilícela solo para reintentar ese mismo documento.

El campo `type` forma parte del cuerpo que se compara: enviar `"type": "FE"` explícito produce un cuerpo distinto de uno sin `type`, aunque ambos sean facturas. No cambie de una forma a otra al reintentar con la misma `Idempotency-Key`, o recibirá `409`.

## Errores

| Código | Significado | Qué hacer |
|---|---|---|
| `400` | `Idempotency-Key` ausente o malformada | Corregir el encabezado |
| `401` | API key ausente, malformada o revocada | Revisar la clave |
| `403` | La API key no tiene el scope requerido | Pedir el scope al operador |
| `409` | Clave de idempotencia reutilizada con otro cuerpo, o numeración agotada | Usar otra clave; si es numeración, avisar al operador |
| `422` | Falló la validación de forma o de reglas fiscales | Corregir según `errors[]`; no reintentar igual |
| `503` | Colisión transitoria de numeración | Reintentar con la misma clave |

Los errores usan `{ "statusCode", "message" }`. El `422` agrega `errors[]` con `field`, `rule` y `message`, por ejemplo:

```json
{
  "statusCode": 422,
  "message": "Validation failed",
  "errors": [
    { "field": "items[0].total", "rule": "pyg-integer", "message": "PYG item total (quantity x unit price) must be an integer" }
  ]
}
```

## Consultar el resultado

| Operación | Ruta |
|---|---|
| Por id | `GET /v1/documents/{id}` |
| Por CDC | `GET /v1/documents?cdc=<44 dígitos>` |
| KuDE (PDF) | `GET /v1/documents/{id}/kude?format=letter\|ticket-80\|ticket-58` (por defecto `letter`; `ticket-80` y `ticket-58` son cinta de papel de 80 y 58 mm para impresoras térmicas). Un `format` desconocido responde `400`. Responde `409` hasta que el documento esté firmado y `422` si su tipo todavía no tiene KuDE (nota de débito, autofactura, remisión) |

El documento incluye `number` (por ejemplo `001-002-0000007`), `status`, `environment`, `issued_at`, `totals.amount` (texto) y `totals.currency`, `receiver.ruc`, `sifen` (código y mensaje de SIFEN, `null` hasta la transmisión) y `urls.xml` / `urls.kude`.

### Estados

`accepted` → `signed` → `queued` → `submitted` → `approved` | `approved_with_observations` | `rejected`. También existen `corrected`, `number_voided` y `cancelled`.

Para conocer el resultado final no haga polling: registre un endpoint y use los eventos `document.approved`, `document.approved_with_observations` y `document.rejected` descritos en [`webhooks.md`](webhooks.md). Un rechazo trae el motivo de SIFEN.

### Correo al receptor

Cuando SIFEN aprueba el documento (`approved` o `approved_with_observations`), la plataforma envía al correo del receptor (`dEmailRec`) un mensaje con dos adjuntos: el KuDE en carta (PDF) y el XML firmado. El remitente es la cuenta de la plataforma y el nombre visible es el del emisor.

- El envío es asíncrono y no bloquea la emisión ni la aprobación: un fallo de correo nunca cambia el estado del documento.
- Hay un único correo por documento; reintentar o reprocesar la aprobación no lo duplica.
- Un receptor sin correo, o con una dirección inválida, no recibe mensaje. El correo se informa en `receiver.email` (ver la tabla del receptor); sin él el documento no lleva `dEmailRec` y no se envía nada.
- Un fallo transitorio (conexión, timeout, SMTP 4xx) se reintenta con espera creciente (1 min, 5 min, 30 min, 2 h y 6 h) y después queda sin enviar. Un rechazo permanente del servidor de correo, o un KuDE que no se pueda generar, no se reintenta.
- Si el envío está apagado en la plataforma (`EMAIL_ENABLED=false`), no se envía nada.

## Alcance actual

- Este endpoint emite **facturas (FE)**, **autofacturas (AFE)**, **notas de crédito (NCE)**, **notas de débito (NDE)** y **notas de remisión (NRE)** electrónicas. Otros tipos de documento no están disponibles por esta ruta.
- La condición de venta es contado, con un único pago en efectivo; no hay forma de expresar crédito ni otros medios de pago.
- Solo moneda `PYG`.

### Validar un receptor por RUC

`GET /v1/ruc/{ruc}` consulta el padrón de SIFEN (`siConsRUC`) con una API key válida, sin scope adicional. El RUC va sin dígito verificador (5 a 8 dígitos). Las respuestas se guardan en una caché compartida durante `RUC_CACHE_TTL_SECONDS` (por defecto un día; ver `docs/configuracion.md`); `cached` indica si la respuesta salió de ella.

| Respuesta | Cuándo |
|---|---|
| `200 { ruc, cached, taxpayer: { legal_name, status, electronic_invoicer } }` | SIFEN encontró el RUC (`status`: `ACT`, `SUS`, `SAD`, `BLQ`, `CAN` o `CDE`) |
| `400` | El RUC no tiene 5 a 8 dígitos |
| `404` | SIFEN no conoce el RUC |
| `502` | SIFEN rechazó la consulta (0501) o no respondió; nunca se reenvía su mensaje |
| `503` | La API no tiene un adaptador SIFEN disponible |
