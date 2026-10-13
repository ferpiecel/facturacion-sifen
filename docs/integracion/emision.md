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
| `operationType` | string | `B2B`, `B2C`, `B2G` o `B2F` |
| `receiver` | objeto | Ver [Receptor](#receptor) |
| `items` | array | De 1 a 999 ítems. Ver [Ítems](#ítems) |
| `roundingPyg` | entero | De 0 a 49. Por defecto 0. Ver [Montos y redondeo](#montos-y-redondeo) |
| `location.departmentCode` | entero | Departamento **del receptor**, de la tabla de [códigos geográficos](#códigos-geográficos) |
| `currency` | string | Solo `PYG`. Por defecto `PYG` |

### Receptor

Receptor identificado (`kind: "named"`):

| Campo | Regla |
|---|---|
| `ruc` | RUC con dígito verificador, formato `base-DV` |
| `isPublicEntity` | Booleano, por defecto `false`. Si es `true`, `operationType` debe ser `B2G` |
| `name` | De 4 a 255 caracteres |
| `address` | Hasta 255 caracteres |
| `houseNumber` | Texto de 1 a 6 dígitos |
| `districtCode` / `districtDescription` | Código entero de 1 a 9999 y descripción de hasta 30 caracteres |
| `cityCode` / `cityDescription` | Código entero de 1 a 99999 y descripción de hasta 30 caracteres |

Receptor innominado (`kind: "unnamed"`): no lleva `ruc` ni `name`. Se rechaza si el total neto es de 7.000.000 Gs o más.

### Códigos geográficos

| Dato | Qué valida la plataforma | Qué debe hacer su sistema |
|---|---|---|
| `location.departmentCode` | Debe estar en la tabla oficial de 20 departamentos; si no, responde `422` con `rule: "department-code"`. La descripción la completa la plataforma | Enviar el código del departamento del receptor |
| `receiver.districtCode` y `receiver.cityCode` | Solo el formato (entero dentro del rango). **No se cruzan contra la tabla oficial de distritos y ciudades** ni entre sí, porque esa tabla aún no está cargada en la plataforma | Enviar los códigos y descripciones **tal como figuran en las tablas de la DNIT** (Manual Técnico v150, tablas 2.1 y 2.2) |
| `districtDescription` y `cityDescription` | Solo la longitud. Se copian al XML sin verificar | Enviar la descripción oficial que corresponde al código |

Un código de distrito o ciudad inexistente, o una descripción que no corresponda, **pasa la validación de la plataforma** y puede ser rechazado luego por SIFEN. El departamento del emisor no se envía: sale del establecimiento configurado.

Departamentos (`cDepEmi`): 1 Capital, 2 Concepción, 3 San Pedro, 4 Cordillera, 5 Guairá, 6 Caaguazú, 7 Caazapá, 8 Itapúa, 9 Misiones, 10 Paraguarí, 11 Alto Paraná, 12 Central, 13 Ñeembucú, 14 Amambay, 15 Presidente Hayes, 16 Boquerón, 17 Alto Paraguay, 18 Canindeyú, 19 Chaco, 20 Nueva Asunción.

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
      "cityCode": 3316,
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

## Idempotencia

`Idempotency-Key` es obligatorio. Reintentar con la **misma clave y el mismo cuerpo** devuelve la misma respuesta sin crear otro documento; la misma clave con otro cuerpo responde `409`. Genere una clave nueva por documento y reutilícela solo para reintentar ese mismo documento.

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
| KuDE (PDF) | `GET /v1/documents/{id}/kude`. Responde `409` hasta que el documento esté firmado |

El documento incluye `number` (por ejemplo `001-002-0000007`), `status`, `environment`, `issued_at`, `totals.amount` (texto) y `totals.currency`, `receiver.ruc`, `sifen` (código y mensaje de SIFEN, `null` hasta la transmisión) y `urls.xml` / `urls.kude`.

### Estados

`accepted` → `signed` → `queued` → `submitted` → `approved` | `approved_with_observations` | `rejected`. También existen `corrected`, `number_voided` y `cancelled`.

Para conocer el resultado final no haga polling: registre un endpoint y use los eventos `document.approved`, `document.approved_with_observations` y `document.rejected` descritos en [`webhooks.md`](webhooks.md). Un rechazo trae el motivo de SIFEN.

## Alcance actual

- Este endpoint emite **facturas electrónicas (FE)**. Otros tipos de documento no están disponibles por esta ruta.
- La condición de venta es contado, con un único pago en efectivo; no hay forma de expresar crédito ni otros medios de pago.
- Solo moneda `PYG`.
