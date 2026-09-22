# ADR-0011: API asíncrona: 202, webhooks e idempotencia

- **Estado:** Aceptado
- **Fecha:** 2026-09-22

## Contexto
La aprobación de un lote puede tardar horas (ADR-0007). Los integradores reintentan ante timeouts.

## Decisión
`POST /v1/documents` exige `Idempotency-Key` y responde **202** con `document_id` y **CDC** apenas se firma. El estado final se notifica por webhook firmado con HMAC y marca de tiempo (anti-replay de 5 min), y se puede consultar por `GET`. Existe un modo `?wait=true` de hasta 30 s solo para tenants con sincrónico habilitado.

## Consecuencias
Los integradores deben implementar el receptor de webhooks. El SDK y la guía del integrador (F5) lo simplifican.

## Alternativas descartadas
API sincrónica bloqueante (inviable con lotes).
