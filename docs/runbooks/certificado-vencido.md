# Runbook: certificado vencido o por vencer

## Síntomas y detección

- Alerta de Prometheus: `CertificadoPorVencer` y `CertificadoVenceEstaSemana` ([reglas](../operacion/alertas.md)).
- Webhook `certificate.expiring` (una vez por certificado y umbral de `CERTIFICATE_ALERT_DAYS`: 60, 30 y 7 días). Se revisa cada `DEADLINE_WATCH_INTERVAL_MS`. Un certificado ya vencido no genera aviso.
- Desde `CERTIFICATE_EMISSION_BLOCK_DAYS` (1 día) antes del vencimiento: `POST /v1/documents` (y notas y autofactura) responde `422` con `code: certificate_expiring` y `notAfter`, sin consumir número.
- Ya vencido: la firma falla con `CertificateValidityError` y el documento queda retenido con `transmission_hold = 'signing:CertificateValidityError'` (el pipeline no reintenta). Tras `certificate:revoke` sin reemplazo la retención es `signing:CertificateNotFoundError`.

## Impacto

Solo el tenant afectado. Antes del vencimiento, nada falla. Con el bloqueo de emisión no se aceptan documentos nuevos; los ya aceptados y sin firmar quedan retenidos. Los ya firmados siguen su transmisión y los certificados revocados no se borran, así los documentos viejos siguen verificables.

## Acciones inmediatas

1. Pedir al tenant el `.p12` renovado (PSC habilitada por el MIC). La plataforma no renueva certificados.
2. Cargarlo reemplazando el anterior (revoca el viejo en la misma transacción):

   ```bash
   read -rs P12_PASSWORD && printf '%s' "$P12_PASSWORD" | KMS_LOCAL_MASTER_KEY="<clave-maestra-base64>" \
     PSC_TRUSTED_ROOTS_PATH=/etc/sifen/psc-roots.pem \
     pnpm --filter @sifen/api ops certificate:add --tenant <tenant-id> --env production --p12 /ruta/segura/nuevo.p12 --password - --replace
   ```

   Falla (sin guardar nada) si el RUC no coincide con `fiscal:set`, la cadena no llega a una raíz PSC, o la huella ya se cargó antes para ese `(tenant, env)`.
3. Liberar los documentos retenidos:

   ```bash
   pnpm --filter @sifen/api ops document:release-holds --tenant <tenant-id> --reason signing:CertificateValidityError
   ```

   (o `signing:CertificateNotFoundError` si el certificado se revocó). Un solo documento: `document:release-hold --tenant <id> --document <id>`.
4. El worker cachea certificados hasta `CERTIFICATE_CACHE_TTL_MS` (5 min por defecto), pero cada uso revalida en la base que siga activo y vigente: el reemplazo aplica de inmediato.
5. Certificado comprometido: `ops certificate:revoke --tenant <id> --fingerprint <sha256-hex> [--env ...]` y cargar uno nuevo como arriba.

## Verificación

- La emisión deja de responder `422 certificate_expiring`.
- Los documentos liberados pasan de `accepted` a `signed` en el siguiente ciclo, y llegan sus webhooks.
- Audit log: `certificate.revoked` (el anterior), `document.hold_released` (por liberación) y `certificate.accessed` (cada descifrado). Se consulta con `ops audit:list --tenant <id> --action certificate.revoked` (ver `operacion.md`).

## Escalamiento

PSC emisora del certificado: `<contacto-PSC>`. DNIT si SIFEN rechaza la firma de un certificado válido: `<contacto-DNIT-soporte-SIFEN>`.

## Post-incidente

Revisar por qué el aviso a 60/30/7 días no se atendió (el tenant debe tener un endpoint de webhooks con `certificate.expiring`). Para ver qué certificados vencen: `ops certificate:expiring [--tenant <id>] [--days <n>]` (ver `operacion.md`).
