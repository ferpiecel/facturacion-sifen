# ADR-0019: Contexto acotado `reception`: documentos recibidos como agregado propio

- **Estado:** Propuesto
- **Fecha:** 2026-11-06

## Contexto

La plataforma solo emite. Cada tenant es facturador con su propio certificado (ADR-0010), pero también recibe facturas emitidas a su nombre (compras). Hoy no existe un agregado para documentos emitidos por terceros, ni almacenamiento de objetos, ni lectura de PDF o foto, ni consulta a eKuatia. El proyecto facturaspy (Python) ya resuelve esto con otro stack y otro modelo de tenancy (`cuenta`, `cuenta_ruc`, login propio); su comportamiento y sus fixtures sirven de referencia, no su código.

Un documento recibido no es un documento emitido: no tiene numeración propia, no se firma, no viaja en un lote y su ciclo de vida (extraer, revisar, confirmar) no se parece al de `documents`. Mezclarlos obligaría a `documents` a admitir estados y columnas que no le corresponden.

## Decisión

1. **Módulo y agregado propios.** Nuevo módulo hexagonal `apps/api/src/modules/reception/` con el agregado `received_documents`, sus ítems, sus confianzas por campo y sus artefactos. No se reutilizan `documents` ni `lotes`.
2. **Máquina de estados propia:** `received → extracting → extracted → (confirmed | needs_review)`, `extracting → extraction_failed`, `needs_review → confirmed` y `extraction_failed → extracting` (reproceso). Es una función pura de dominio.
3. **Tenancy.** Toda tabla lleva `tenant_id` con `ENABLE` y `FORCE ROW LEVEL SECURITY` y una política `FOR ALL` para `app_user` (ADR-0005, 0006, 0016). Los hijos referencian al padre con FK compuesta `(tenant_id, id)`, de modo que una referencia entre tenants es imposible.
4. **Receptor propio.** Se deriva de `tenant_fiscal_profiles` (`ruc_base` y `ruc_dv`). Un tenant tiene un solo RUC; un segundo RUC es un segundo tenant. No existe un equivalente a `cuenta_ruc`.
5. **Receptor distinto del tenant.** El documento se guarda con `is_own_receiver = false`, sigue siendo visible y marcado en la API y el portal, y no emite ningún evento de webhook.
6. **Partner.** `partner_viewer` no recibe ningún permiso sobre las tablas de recepción: el partner ve metadatos operativos, no contenido de documentos (consistente con ADR-0014).
7. **Reuso.** `reception/domain` importa los helpers puros `parseCdc` y `computeCdcCheckDigit` (emission), `parseRuc` y `computeRucCheckDigit` (fiscal-config) y `Decimal` (ADR-0018) por sus archivos públicos. No se crea un kernel compartido por ahora. Montos en `numeric(23,8)`.
8. **API primero.** El consumidor principal es el software del tenant (típicamente un ERP): sube por `/v1/received-documents`, recibe webhooks, consulta, corrige y confirma con un único `PATCH`. El portal ofrece solo lectura (lista y detalle). Sin borrado: los documentos fiscales se conservan.
9. **Fuera de alcance.** Eventos del receptor (conformidad, disconformidad, desconocimiento; HU-E9-01), migración de datos desde facturaspy y moneda extranjera.

ADR-0010 y ADR-0014 no requieren enmienda: tratan de la emisión y de la jerarquía partner → tenant, y este ADR las extiende sin contradecirlas.

## Consecuencias

Se agrega un módulo grande con su propio esquema, cola y API, que se entrega en PRs encadenados. `documents` queda intacto. Un tenant con más de un RUC no está soportado. Los documentos con receptor distinto quedan almacenados pero silenciosos, lo que evita avisar al ERP de compras ajenas. La futura funcionalidad de eventos del receptor tiene un agregado donde colgarse.

## Alternativas descartadas

- **Reutilizar `documents` con una columna de dirección:** contamina un agregado que modela emisión (firma, lote, numeración) con estados y columnas ajenos.
- **Rechazar documentos de otro receptor:** pierde la captura y no deja evidencia; se prefirió guardar y marcar.
- **Soportar varios RUC por tenant (`cuenta_ruc`):** contradice ADR-0010 (un tenant, un facturador) sin necesidad demostrada.
- **Kernel compartido para CDC, RUC y Decimal:** movimiento de código sin beneficio hoy; se reconsidera si aparece un tercer consumidor.
