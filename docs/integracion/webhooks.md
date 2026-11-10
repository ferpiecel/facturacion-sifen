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
5. Deduplique por `id` del evento: un mismo evento puede entregarse más de una vez. Conserve los ids
   vistos al menos `tolerancia + ventana de reintentos` (5 min + 24 h), o un reintento tardío se procesará dos veces.
6. Cada reintento se **vuelve a firmar con un `t` nuevo**: no compare firmas entre intentos, valide cada una.

> No use un parser JSON (`express.json()`, `body-parser`) antes de verificar: re-serializar el cuerpo cambia
> los bytes y la firma deja de coincidir. Verifique sobre el cuerpo crudo y recién después haga `JSON.parse`.

Ejemplo en Node (Express):

```js
import crypto from 'node:crypto';
import express from 'express';

const app = express();
const SECRET = process.env.SIFEN_WEBHOOK_SECRET; // whsec_...

app.post('/hooks/sifen', express.raw({ type: 'application/json' }), (req, res) => {
  const header = req.get('Sifen-Signature') ?? '';
  if (header.length > 2048) return res.sendStatus(400);
  const t = /(?:^|,)t=(\d{1,15})(?:,|$)/.exec(header)?.[1];
  const sigs = [...header.matchAll(/(?:^|,)v1=([0-9a-f]{64})(?=,|$)/g)].map((m) => m[1]);
  if (!t || sigs.length === 0) return res.sendStatus(400);
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return res.sendStatus(400);
  const expected = crypto.createHmac('sha256', SECRET).update(`${t}.`).update(req.body).digest();
  const ok = sigs.some((hex) => {
    const got = Buffer.from(hex, 'hex');
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
  if (!ok) return res.sendStatus(400);
  const event = JSON.parse(req.body.toString('utf8')); // deduplique por event.id
  res.sendStatus(200);
});
```

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

`created_at` va en UTC. `data` solo contiene JSON plano. Tipos (plan v1.0 §13 más las altas de v1.1 §19):
`document.created`, `document.signed`, `document.submitted`, `document.approved`,
`document.approved_with_observations` (v1.0: `approved_with_warnings`), `document.rejected`,
`document.cancelled`, `document.number_voided`, `document.transmission_deadline_warning`,
`document.notification.delivered`, `document.notification.failed`. Un endpoint sin filtro recibe todos.

## Eventos de documentos recibidos (ADR-0023)

Además de los eventos de emisión, la recepción publica cuatro eventos `reception.document.*`. Se
suscriben igual que los demás (`events` del endpoint; sin filtro, todos) y usan el mismo sobre, firma y
reintentos.

| Tipo | Cuándo |
|---|---|
| `reception.document.confirmed` | El documento pasa a `confirmed` (confirmado al subirlo o por `PATCH` con `confirm`) |
| `reception.document.needs_review` | El documento queda en `needs_review`: una persona o el ERP debe corregirlo (`PATCH`) |
| `reception.document.extraction_failed` | No se pudo leer el archivo subido |
| `reception.document.updated` | Se edita un documento ya `confirmed` |

La carga es mínima: identificadores, estado, versión y un enlace. **Nunca** lleva datos fiscales del
documento (RUC, razón social, montos, CDC, ítems); léalos con `GET /v1/received-documents/{id}`.

```json
{
  "id": "evt_9f1c...",
  "type": "reception.document.needs_review",
  "created_at": "2026-11-10T15:00:00.000Z",
  "tenant_id": "tnt_...",
  "data": {
    "document_id": "5b3f0f4e-7a49-4b61-9a5e-3a1f2c9d8e10",
    "status": "needs_review",
    "version": 1,
    "links": { "self": "/v1/received-documents/5b3f0f4e-7a49-4b61-9a5e-3a1f2c9d8e10" },
    "reasons": ["totals_blocks_sum_mismatch"]
  }
}
```

- `reasons` (códigos de motivo) solo va en `needs_review`.
- `actor` solo va en `updated`: `{ "type": "api_key", "id": "<id de la API key>" }`, `{ "type": "portal" }`
  o `{ "type": "system" }`. `version` es la versión **posterior** al cambio.
- El `id` del evento es determinista por documento, tipo y versión: un reintento del servidor no crea un
  evento nuevo y cada edición posterior de un documento confirmado es un evento distinto.
- Un documento cuyo receptor no es el tenant (`is_own_receiver = false`) se guarda pero **no genera
  ningún evento**, de ningún tipo.

### Ignorar el eco de los cambios propios

`reception.document.updated` se emite **siempre**, también cuando el cambio lo hizo la API key del propio
endpoint (el ERP que llamó al `PATCH`). Para no procesar su propio eco, el ERP ignora el evento cuando se
cumplen las dos condiciones:

1. `data.actor.type == "api_key"` y `data.actor.id` es el id de la API key con la que hizo el `PATCH`; y
2. `data.version` es igual a la `version` que devolvió ese `PATCH` (el `version` del cuerpo de respuesta).

Si el actor es otra API key, `portal` o `system`, o la versión es otra, el cambio no es suyo: debe
procesarlo. Ejemplo: el ERP corrige el documento y el `PATCH` responde `"version": 3`; llega

```json
{
  "type": "reception.document.updated",
  "data": {
    "document_id": "5b3f0f4e-7a49-4b61-9a5e-3a1f2c9d8e10",
    "status": "confirmed",
    "version": 3,
    "links": { "self": "/v1/received-documents/5b3f0f4e-7a49-4b61-9a5e-3a1f2c9d8e10" },
    "actor": { "type": "api_key", "id": "key_..." }
  }
}
```

con su propia API key y `version` 3: es su eco y se descarta. Un `updated` con `version` 4 de esa misma
API key es una edición posterior que sí debe procesar.

## Garantía de entrega: al menos una vez

Los eventos se entregan **al menos una vez**, no exactamente una: si su receptor responde `2xx` pero la
respuesta se pierde, o el envío se corta a mitad, el evento se reintenta. Como cada intento lleva un `t` nuevo,
la firma **cambia entre intentos del mismo evento**: no use la firma como identificador. Deduplique siempre
por el `id` del evento (`evt_...`), que es el mismo en todos los intentos, y haga el procesamiento idempotente.

## Reintentos

Backoff exponencial desde 1 min, tope de 4 h por intervalo, con jitter (entre la mitad y el total del
intervalo). Se reintenta hasta 24 h desde el primer intento; el último intento cae como máximo a las 24 h.
Agotado el plazo, la entrega pasa a la cola de entregas muertas (DLQ) y queda en el historial.
