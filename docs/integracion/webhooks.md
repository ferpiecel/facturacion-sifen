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
`document.cancelled`, `document.number_voided`, `document.nominated`, `document.transmission_deadline_warning`,
`document.notification.delivered`, `document.notification.failed`, `certificate.expiring`. Un endpoint sin filtro recibe todos.

### `document.nominated`

SIFEN aprobó la nominación de una FE emitida a un receptor innominado (`POST /v1/documents/{id}/nominate`). El documento
conserva su estado (`approved`): el evento solo avisa que ya tiene receptor. Una nominación rechazada no genera aviso.
`data` lleva `document_id`, `cdc`, `document_type`, `status` y, si existen, los `sifen_messages` del documento; el receptor
nominado no viaja en el webhook (se informa por la API). El `id` es determinista por documento: una sola nominación abierta
por FE (4453), así que el aviso sale una vez.

### `document.transmission_deadline_warning`

SIFEN da 72 h desde la firma para transmitir un documento (ADR-0008). Mientras un documento siga `signed`,
`queued` o `submitted`, se emite este evento **una vez** al cumplirse las 48 h y **una vez** al cumplirse las 66 h
desde la firma. Un documento aprobado, rechazado o cancelado, o ya vencido, no genera avisos.

```json
{
  "id": "evt_...",
  "type": "document.transmission_deadline_warning",
  "created_at": "2026-10-04T12:00:00.000Z",
  "tenant_id": "tnt_...",
  "data": {
    "document_id": "doc_...",
    "cdc": "...",
    "threshold_hours": 66,
    "transmission_deadline": "2026-10-04T18:00:00.000Z",
    "hours_remaining": 6
  }
}
```

`hours_remaining` va redondeado a una décima de hora. El `id` es determinista por documento y umbral, así que la
deduplicación por `id` descarta cualquier repetición. El worker revisa cada `DEADLINE_WATCH_INTERVAL_MS`
(5 min por defecto): el aviso puede llegar con ese retraso. Un documento que ya pasó las 66 h cuando el worker lo
ve por primera vez recibe los dos avisos.

### `certificate.expiring`

Avisa que el certificado activo del tenant (en su ambiente vigente) está por vencer. Se emite **una vez** por
certificado al cruzar cada umbral de `CERTIFICATE_ALERT_DAYS` (60, 30 y 7 días por defecto); si se cruzan varios
a la vez (certificado cargado tarde, worker caído) llega solo el más cercano. Un certificado ya vencido no genera
aviso. Desde el día anterior al vencimiento la API rechaza la emisión con `422`.

```json
{
  "id": "evt_...",
  "type": "certificate.expiring",
  "created_at": "2026-12-02T12:00:00.000Z",
  "tenant_id": "tnt_...",
  "data": {
    "certificate_id": "...",
    "environment": "production",
    "fingerprint": "<sha-256 hex>",
    "not_after": "2027-01-01T00:00:00.000Z",
    "threshold_days": 30,
    "days_remaining": 29
  }
}
```

## Garantía de entrega: al menos una vez

Los eventos se entregan **al menos una vez**, no exactamente una: si su receptor responde `2xx` pero la
respuesta se pierde, o el envío se corta a mitad, el evento se reintenta. Como cada intento lleva un `t` nuevo,
la firma **cambia entre intentos del mismo evento**: no use la firma como identificador. Deduplique siempre
por el `id` del evento (`evt_...`), que es el mismo en todos los intentos, y haga el procesamiento idempotente.

## Reintentos

Backoff exponencial desde 1 min, tope de 4 h por intervalo, con jitter (entre la mitad y el total del
intervalo). Se reintenta hasta 24 h desde el primer intento; el último intento cae como máximo a las 24 h.
Agotado el plazo, la entrega pasa a la cola de entregas muertas (DLQ) y queda en el historial.
