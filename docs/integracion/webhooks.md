# Webhooks firmados (HU-E11-01)

Referencia para integradores. Decisión: [ADR-0011](../adr/0011-api-asincrona-202-webhooks-idempotencia.md).

## Entrega

`POST` a la URL HTTPS registrada, con cuerpo JSON y estos encabezados:

| Encabezado | Valor |
|---|---|
| `Content-Type` | `application/json` |
| `Sifen-Signature` | `t=<unix>,v1=<hex>` |

Responda con un `2xx` en menos de 10 s. Cualquier otra respuesta, error de red o timeout se reintenta.

## Firma

`v1 = hex(HMAC-SHA256(secreto, "<t>.<cuerpo crudo>"))`, donde `t` es la hora de envío en segundos Unix.

1. Lea el cuerpo **crudo** (sin re-serializar) y el encabezado `Sifen-Signature`.
2. Recalcule el HMAC con su secreto (`whsec_...`) y compare **en tiempo constante**.
3. Rechace si `|ahora - t| > 300 s` (anti-replay, ADR-0011).
4. Durante una rotación de secreto el encabezado trae un `v1` por secreto activo; basta que uno coincida.
5. Deduplique por `id` del evento: un mismo evento puede entregarse más de una vez.

El helper de referencia es `verifyWebhookSignature` (`apps/api/src/modules/webhooks/domain/webhook-signature.ts`).

## Evento

```json
{
  "id": "evt_01HZ...",
  "type": "document.approved",
  "created_at": "2026-09-22T17:30:00.000Z",
  "tenant_id": "tnt_...",
  "data": { "document_id": "doc_...", "cdc": "..." }
}
```

`created_at` va en UTC. Tipos: `document.approved`, `document.approved_with_observations`,
`document.rejected`, `document.cancelled`, `document.number_voided`,
`document.transmission_deadline_warning` (plan v1.1 §19). Un endpoint sin filtro recibe todos.

## Reintentos

Backoff exponencial desde 1 min, tope de 4 h por intervalo, con jitter (entre la mitad y el total del
intervalo). Se reintenta hasta 24 h desde el primer intento; el último intento cae como máximo a las 24 h.
Agotado el plazo, la entrega pasa a la cola de entregas muertas (DLQ) y queda en el historial.
