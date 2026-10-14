# ADR-0017: Dirección del receptor y propiedad del catálogo geográfico

- **Estado:** Aceptado
- **Fecha:** 2026-10-13

## Contexto

`POST /v1/documents` exigía dirección, número de casa, departamento, distrito y ciudad para todo receptor con nombre. El Manual Técnico v150 (grupo D3) hace la dirección opcional (D213, 0-1), salvo para B2F (D202 = 4) y la Nota de Remisión, así que la API era más estricta que la norma y obligaba a los integradores a inventar datos. Además, para B2F la norma prohíbe informar departamento y ciudad (D219, D223).

Los códigos de distrito y ciudad solo se validaban por formato y sus descripciones se copiaban al XML, pero SIFEN rechaza una descripción que no corresponde al código (NT 010, validación 1325; NT 017, validación 1329). La tabla geográfica (Tabla 2.1) es un archivo externo publicado por la DNIT que todavía no está en el repositorio.

## Decisión

**Contrato (HU-E5-08).** Se mantienen los nombres planos de los campos para no romper a los integradores que ya usan el OpenAPI; solo cambian las reglas.

- `receiver.address`, `houseNumber`, `districtCode`/`districtDescription` y `cityCode`/`cityDescription`, y `location.departmentCode`, son opcionales.
- El bloque de dirección es todo o nada: con dirección se exige número de casa (D218, NT 014 4470) y, salvo B2F, departamento y ciudad (D219/D223; 1324/1327). Número de casa, distrito o ciudad sin dirección se rechazan, igual que un departamento sin dirección.
- B2F exige dirección (NT 014 4478) y rechaza departamento y ciudad.
- Código y descripción de distrito, y de ciudad, se informan juntos (D221/D222, D223/D224).
- Las reglas viven en `validateInvoiceDraft` (dominio puro); el esquema del request solo valida formato y los pares código/descripción. El mapeo a `xmlgen` omite los campos ausentes y, en B2F, departamento, distrito y ciudad.

**Catálogo.** El catálogo geográfico es dato versionado en el repositorio, no se consulta en tiempo de ejecución, para que la validación sea determinista y no dependa del portal de la DNIT.

1. **Ubicación del dataset:** `packages/sifen-xsd/vendor`, junto a las demás tablas de la DNIT (por ejemplo `Departamentos_v141.xsd`), con su suma de verificación en `checksums.json`. No se crea un módulo nuevo en `fiscal-config`: el dato no pertenece a un tenant ni cambia por tenant.
2. **Alcance de los endpoints de lectura** (`GET /v1/geo/departments`, `/districts?departmentCode=`, `/cities?districtCode=`): solo exigen una API key válida, sin scope adicional. El catálogo es público; un scope `documents:read` mezclaría datos públicos con permisos sobre documentos. Los endpoints filtran por padre, de modo que ninguno devuelve la lista completa de ciudades.
3. La descripción del departamento sigue resuelta por la plataforma; las de distrito y ciudad se validan contra el catálogo (no se confía en el integrador) cuando llegue el dataset.

Cuando el dataset esté vendorizado se registrará su fuente, fecha y SHA-256 en el README del vendor.

## Consecuencias

- **Cambio incompatible, solo para B2F:** quien enviaba departamento o ciudad con `operationType: "B2F"` ahora recibe 422 (`receiver-department-not-allowed`, `receiver-city-not-allowed`), y B2F sin dirección también (`receiver-address-required`). El distrito sigue permitido en B2F (solo D219 y D223 están prohibidos). Para el resto de operaciones el cambio afloja validaciones y es compatible: un receptor innominado que siga enviando `location.departmentCode` (los clientes existentes lo hacen, era obligatorio) no se rechaza; el código se ignora, se valida contra la tabla y no se informa en el XML.
- Hallazgo: `xmlgen` ya omite `cDepRec`, `cDisRec` y `cCiuRec` cuando `tipoOperacion = 4`, pero para B2F exige además un receptor no contribuyente de un país distinto de PRY, algo que la API aún no modela (el receptor con nombre siempre lleva RUC). La emisión de XML B2F sigue sin ser posible; esta decisión solo alinea el contrato. Tampoco se puede construir XML B2G (`dEntCont`, datos de compras públicas pendientes), independientemente de la dirección.
- `xmlgen` conserva su propia tabla geográfica y sobrescribe departamento y distrito a partir de la ciudad. El catálogo oficial vendorizado será la fuente de validación previa a la aceptación; reconciliarlo con la tabla de la librería queda como validación pendiente.
- Las reglas dependientes del catálogo (existencia, pertenencia ciudad-distrito-departamento, descripción igual al código) llegan en los slices siguientes y no bloquean este contrato.

## Alternativas descartadas

- Renombrar los campos a un objeto `address` anidado: rompería a los integradores actuales sin beneficio para la norma.
- Consultar la tabla en tiempo de ejecución desde el portal de la DNIT: validación no determinista y dependencia externa en el camino de aceptación.
- Exigir `documents:read` en los endpoints del catálogo: acopla un dato público a permisos sobre documentos.
- Dataset en un módulo de `fiscal-config`: sugiere una pertenencia por tenant que no existe.

**Adenda (2026-10-14):** el PO difirió B2G y B2F del MVP. `POST /v1/documents` los rechaza con 422 `operation-type-not-supported` antes de consumir numeración; un receptor entidad pública tampoco se puede facturar (exige B2G). Las reglas de dirección de B2F de este ADR se mantienen en el código, listas para cuando se habilite.
