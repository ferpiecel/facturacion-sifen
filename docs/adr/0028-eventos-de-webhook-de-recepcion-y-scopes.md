# ADR-0028: Eventos de webhook de recepción y scopes `reception:*`

- **Estado:** Propuesto
- **Fecha:** 2026-11-06

## Contexto

El consumidor principal de la recepción es el software del tenant (un ERP): sube el documento, espera un aviso, lo consulta, lo corrige y lo confirma por API. El módulo `webhooks` ya entrega eventos firmados con reintentos (ADR-0011) y mantiene la lista de tipos de evento en tres lugares con una prueba de paridad: `WEBHOOK_EVENT_TYPES` en `packages/db/src/schema.ts`, las restricciones CHECK `webhook_endpoints_events_valid` y `webhook_deliveries_event_type_valid`, y `webhook-event.ts`. Los scopes de API key son cadenas libres (`documents:read`, `webhooks:write`).

## Decisión

1. **Eventos.** `reception.document.confirmed`, `reception.document.needs_review`, `reception.document.extraction_failed` y `reception.document.updated`. No hay `deleted`: el borrado queda fuera de alcance.
2. **`needs_review` es el evento central.** Avisa al ERP de que una persona debe corregir. Su carga lleva el id, el estado, los códigos de motivo y el enlace, sin datos fiscales extraídos.
3. **Carga mínima más enlace** (convención de B). Todos los eventos llevan id del documento, `status`, `version` y enlace a `GET /v1/received-documents/{id}`.
4. **Eco de `updated`.** `reception.document.updated` se emite siempre, también para cambios hechos por la API key del propio endpoint. La carga incluye `actor` (`api_key` con su id, `portal` o `system`), la `version` posterior al cambio y el `status`. La guía de integración documenta la regla exacta para que un ERP ignore sus propios ecos (misma API key y la versión que acaba de escribir) y un ejemplo.
5. **Silencio por receptor ajeno.** Un documento con `is_own_receiver = false` no encola ningún evento de ningún tipo (ADR-0024).
6. **Identidad del evento.** Id determinista (hash), como los eventos de documentos, con `UNIQUE(endpoint_id, event_id)`. El encolado ocurre dentro de la transacción que cambia el estado.
7. **Ampliación de la lista.** Una migración amplía los dos CHECK, se actualiza `WEBHOOK_EVENT_TYPES` y `webhook-event.ts`, y la prueba de paridad debe fallar antes del cambio. Se vuelve a probar el trigger de guarda de `webhook_endpoints`.
8. **Scopes.** `reception:read` (listar, obtener, artefacto) y `reception:write` (subir, corregir y confirmar, reprocesar). Los endpoints y entregas de webhook siguen usando `webhooks:read|write`.

Este ADR amplía por adición el catálogo de eventos de ADR-0011; no edita su texto.

## Consecuencias

Los integradores reciben un aviso accionable sin que la carga exponga datos fiscales. El eco de `updated` obliga al ERP a filtrar sus propios cambios, y la guía lo documenta. Ampliar los CHECK toca tablas compartidas con la emisión, por lo que requiere migración con rollback y repetir las pruebas de paridad y de la guarda.

## Alternativas descartadas

- **Suprimir el eco para la API key propia:** acopla el evento a quién lo recibe y oculta cambios legítimos hechos por otros actores.
- **Emitir `updated` solo en la confirmación:** pierde correcciones posteriores a documentos ya confirmados.
- **Carga completa del documento:** expone datos fiscales por un canal de entrega con reintentos y contradice la convención de carga mínima.
- **Un scope por acción (`reception:confirm`):** granularidad sin necesidad demostrada; se reconsidera si aparece un rol que solo confirme.
