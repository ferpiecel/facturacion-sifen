# Runbook: corrección con reclamo vencido

## Síntomas y detección

- `POST /v1/documents/{id}/correct` responde `409 correction_in_progress` mucho después de la primera corrección y el integrador no la va a reintentar (cambió de clave, abandonó el documento o la clave se perdió).
- Una reemisión rechazada por una causa externa o dependiente del tiempo (certificado vencido o por vencer, punto sin configurar) conserva el reclamo; un cuerpo inválido no lo toma (422 sin reclamo): no se libera sola. Se corrige la causa y se reintenta con la **misma** `Idempotency-Key` y cuerpo, o se libera con `release-claim`.
- El documento sigue `rejected` y tiene una fila en `document_correction_claims` (el reclamo que toma una reemisión antes de emitir el reemplazo, ADR-0021).

## Impacto

Solo ese documento: ninguna otra corrección (reescritura con el mismo CDC o reemisión) puede empezar mientras el reclamo exista. No afecta a otros documentos ni a la transmisión.

## Acciones inmediatas

1. Pedir al integrador que reintente primero con la **misma** `Idempotency-Key` y el mismo cuerpo: retoma la reemisión, vincula el reemplazo ya emitido y anula el número viejo. Es el camino normal.
2. Si no va a reintentar, confirmar que no hay reemplazo: buscar un documento del tenant cuyo `idempotency_key` sea `<sha256 de {"reissueOf":"<id>"}>:reissue`. El comando del paso 3 lo hace por vos y se niega si existe.
3. Liberar el reclamo vencido:

   ```bash
   pnpm --filter @sifen/api ops correction:release-claim --tenant <tenant-id> --document <document-id> --actor <operador>
   ```

   Rechaza un documento sin reclamo, uno de otro tenant y uno cuyo reemplazo ya existe (en ese caso hay que vincularlo reintentando con la misma clave; liberar el reclamo permitiría que una reescritura posterior deje dos documentos vivos). Cada liberación queda en el audit log (`correction.claim_released`, con el operador y la clave del reclamo).

## Verificación

- El comando imprime `correction claim released: <document-id> (key <clave>)`.
- Una nueva corrección del documento ya no responde 409 `correction_in_progress`.

## Postmortem

Registrar tenant, documento, tiempo transcurrido desde el reclamo y por qué el integrador no reintentó.
