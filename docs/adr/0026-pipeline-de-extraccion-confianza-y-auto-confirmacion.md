# ADR-0026: Pipeline de extracción, confianza por campo y política de auto-confirmación

- **Estado:** Propuesto
- **Fecha:** 2026-11-06

## Contexto

La recepción ingiere documentos de terceros desde XML SIFEN, enlace CDC/QR y PDF o foto (ADR-0024). Solo el XML es determinístico; un PDF o una foto exigen visión por LLM, que puede equivocarse y cuyo costo y privacidad hay que acotar. El proyecto A (facturaspy) ya resolvió el flujo: confianza 1.0 para XML, texto del PDF y QR antes del LLM, salida JSON con esquema, caché de prompt y modelo de respaldo, ocho campos con confianza y un umbral de 0.85. Tiene dos defectos que no se portan: el umbral está duplicado en `ingesta_extraccion.py` y `reprocess.py`, y no valida los dígitos verificadores de RUC ni CDC.

## Decisión

1. **Orden del pipeline.** XML SIFEN: parser determinístico, confianza 1.0 en todos los campos. PDF: primero capa de texto y QR para obtener el CDC; solo si no alcanza se rasteriza y se llama al LLM. Foto: QR primero, luego LLM.
2. **LLM.** Puerto `extraction-llm.port.ts`; adaptador con `@anthropic-ai/sdk` solo en `infrastructure/adapters/`. Visión con salida JSON-schema (esquema zod en el dominio), caché de prompt en el system prompt y un único modelo de respaldo ante error, rechazo o JSON inválido. Los modelos se configuran con `RECEPTION_EXTRACTION_MODEL` (por defecto `claude-sonnet-5`) y `RECEPTION_EXTRACTION_FALLBACK_MODEL` (por defecto `claude-haiku-4-5`; la cadena exacta se confirma en R5.3). Ningún identificador de modelo queda fijo en el código.
3. **Confianza por campo.** Ocho campos curados: `issuer_ruc`, `issuer_legal_name`, `issued_on`, `document_number`, `receiver_ruc`, `payment_condition`, `totals`, `items`. Se guarda un valor 0..1 por campo y una confianza global.
4. **Política de confirmación.** Un único umbral configurable (`RECEPTION_AUTO_CONFIRM_THRESHOLD`, por defecto 0.85) definido en `domain/confidence-policy.ts`, sin copias. El documento pasa a `confirmed` solo si la confianza supera el umbral, las validaciones aritméticas pasan (tolerancia `RECEPTION_TOTALS_TOLERANCE`, por defecto 1.00 Gs) y están los campos obligatorios; si no, pasa a `needs_review` con códigos de motivo.
5. **Validaciones nuevas respecto de A.** Dígito verificador de RUC y de CDC, con `computeRucCheckDigit` y `computeCdcCheckDigit`. Los montos viajan como cadenas y se operan con `Decimal` (ADR-0018), nunca con `number`.
6. **Asincronía y costo.** El procesamiento corre en BullMQ con cargas que llevan solo ids (ADR-0013). Topes diarios por tenant (`RECEPTION_EXTRACTION_DAILY_CAP`) y límites de concurrencia; los registros llevan ids y conteos, nunca imágenes ni texto del documento.
7. **Privacidad.** Las imágenes de las facturas se envían a Anthropic. Esto debe constar en la documentación de integración y requiere la decisión del dueño sobre datos personales y fiscales y el acuerdo de tratamiento de datos (riesgo R-4 del plan).
8. **Salida del LLM no confiable.** El texto del documento puede contener inyección de instrucciones. La salida se valida con zod y con las reglas aritméticas y de formato, y nunca se interpreta como instrucción ni dispara acciones.
9. **Puertos de bibliotecas.** `pdf-renderer.port.ts` (texto, rasterización con tope de páginas y dpi, conteo) y `qr-decoder.port.ts` (CDC desde imagen, `null` si no hay QR legible, sin lanzar). Las bibliotecas viven solo en `infrastructure/adapters/`.
10. **Elección de bibliotecas: pendiente de los spikes R5.4 y R5.5.** Este ADR fija los criterios y se enmienda con la decisión. Criterios: licencia (incluido el riesgo de AGPL), tamaño del paquete o del wasm, soporte de Node 22, arranque en frío, sin binarios de sistema. Candidatos para PDF: `pdfjs-dist` (ya es devDependency en 6.3.289; la rasterización exige un canvas), un paquete wasm de pdfium y `mupdf` en wasm. Candidatos para QR: `jsqr` (ya es devDependency en 1.4.0; necesita píxeles RGBA) y `zxing-wasm`, más un decodificador de imágenes (`sharp`, `pngjs`, `jpeg-js`). Licencias, tamaños y compatibilidad con Node 22: a verificar en el spike R5.4/R5.5; no se afirman aquí.

## Consecuencias

El umbral y la tolerancia son configurables y viven en un solo lugar. El QR y el texto del PDF reducen llamadas al LLM, y con ellas costo y exposición de datos. Aumenta la superficie de configuración (modelos, umbral, topes) y se depende de un proveedor externo; sin `ANTHROPIC_API_KEY` la extracción responde 503 `extraction_unavailable` y el XML sigue funcionando. El QR no es obligatorio: A lo trataba como opcional y aquí también (su ausencia no falla el documento). Si los spikes descartan todas las opciones sin binarios de sistema, se enmienda este ADR.

## Alternativas descartadas

- **Auto-confirmar solo por confianza global:** oculta errores de totales o de campos obligatorios; se exigen además las validaciones.
- **Umbral fijo en código (como A):** contradice la regla de valores en disputa configurables y repite la duplicación de A.
- **Llamar al LLM siempre, sin QR ni capa de texto:** más costo, más datos enviados y menos certeza sobre el CDC.
- **Montos como `number` en la salida del LLM:** pierde precisión (ADR-0018).
- **Fijar ya la biblioteca de PDF o QR:** sin medir licencia, tamaño y Node 22 el riesgo es alto; decide el spike.

## Adenda: spike R3.2 (parser de XML SIFEN)

Decisión: `libxml2-wasm` 0.7.2 (licencia MIT, 1,3 MB instalado, ya fijado en `packages/sifen-xsd`), declarado como dependencia exacta de `apps/api` y usado solo en `modules/reception/infrastructure/adapters/libxml2-sifen-xml-parser.adapter.ts`. No se agrega ninguna versión nueva al repositorio.

- **Por qué:** ya está en el lockfile y en producción para la validación XSD (sin superficie de dependencias nueva), maneja espacios de nombres con XPath y expone `XML_PARSE_NO_XXE` y `XML_PARSE_NONET`. Candidato descartado: `fast-xml-parser` (MIT, JS puro): agrega una dependencia, devuelve objetos sin tipos de nodo y su procesamiento de entidades es una opción más que hay que acordarse de limitar. Un parser SAX/streaming no aporta nada a documentos de 4 a 12 KB con tope de 2 MiB.
- **XXE y billion laughs:** el adaptador rechaza por completo cualquier `<!DOCTYPE`, `<!ENTITY`, `<!ELEMENT`, `<!ATTLIST` o `<!NOTATION` escaneando los bytes antes de parsear (los documentos SIFEN nunca llevan DTD), rechaza UTF-16/32 y EBCDIC porque no se pueden escanear, y como defensa en profundidad parsea con `NO_XXE | NONET`. Los mensajes de error no incluyen contenido del documento.
- **Tope de tamaño:** `maxBytes` configurable en el constructor, por defecto 2 MiB, verificado antes de decodificar.
- **Tipos soportados:** solo `iTiDE` 1 (factura electrónica), el único con fixtures reales y el único que A mapea. Los demás códigos lanzan `UnsupportedDocumentTypeError`; ampliar el conjunto exige fixtures reales.
- **Formas:** `rDE` con o sin espacio de nombres y envuelto en otro elemento; la búsqueda usa `local-name()`.
- **Medido:** los 5 XML dorados (4 a 8 KB) se parsean en milisegundos dentro de la suite (21 pruebas en unos 40 ms en total). No se hizo un benchmark formal; no se afirma más.
- **Riesgo conocido:** `xmlRegisterInputProvider` de libxml2-wasm es global al proceso (lo registra `@sifen/sifen-xsd`); el parser no resuelve recursos externos, así que no depende de él.
