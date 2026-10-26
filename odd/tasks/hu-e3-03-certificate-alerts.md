# HU-E3-03 Alertas de vencimiento del certificado

Objetivo: avisar al tenant a 60, 30 y 7 días del vencimiento de su certificado activo y bloquear la
emisión desde el día anterior al vencimiento (RNF-02). Umbrales configurables.

TDD: estricto (`openspec/config.yaml`), runner Vitest. Ruta: delegada (un escritor, sifen-writer), inline por tarea.
Delivery: `ask-on-risk`; PRs encadenados de <= 400 líneas. Migración: solo 0060.

## Diseño

- Canal: webhook existente. Evento nuevo `certificate.expiring` (el módulo de email E11 solo envía
  documentos aprobados a receptores; no es canal de alertas al tenant). Requiere migración 0060 (dos CHECK de
  tipos de evento: `webhook_endpoints_events_valid`, `webhook_deliveries_event_type_valid`).
- Dedupe: id de evento determinista `evt_<sha256(certId:certificate.expiring:umbral)>` + `UNIQUE(endpoint_id, event_id)`
  (`onConflictDoNothing`), igual que HU-E6-07. Sin tabla nueva.
- Planificación: se engancha al job repetible por tenant `deadline-watch` ya existente (misma ruta por tenant con
  `withTenantTransaction`, sin cola ni schedule nuevos). Un tenant sin endpoint activo no recibe alerta (deuda: aviso en portal).
- Umbral que aplica: el más chico ya cruzado y aún no vencido; si se cruzan varios a la vez (alta tardía) se avisa solo el
  más cercano, para no enviar 3 eventos juntos. Un certificado ya vencido no genera alerta (lo cubre el bloqueo).
- Bloqueo: `resolveIssuer` devuelve `certificateNotAfter` del certificado activo del ambiente del tenant; los cuatro casos
  de aceptación lanzan `CertificateExpiringError` (422) si `now >= notAfter - blockDays`. Sin certificado activo no cambia
  el comportamiento actual (la firma retiene el documento).
- Config: `CERTIFICATE_ALERT_DAYS` (def. `60,30,7`), `CERTIFICATE_EMISSION_BLOCK_DAYS` (def. `1`). Documentar en `docs/configuracion.md`.

## Tareas

- [ ] T1 (PR 1) Migración 0060 + tipo de evento `certificate.expiring` (db, API, OpenAPI, docs), umbrales y bloqueo en el
      dominio (`certificate-expiry.ts`), id/payload del evento, con tests (RED observado).
- [ ] T2 (PR 2) Caso de uso `WarnCertificateExpiry`, store Drizzle y outbox `enqueueCertificateExpiry`, con tests sobre PGlite.
- [ ] T3 (PR 3) Cableado en el processor `deadline-watch`, config `CERTIFICATE_ALERT_DAYS`, `docs/configuracion.md`.
- [ ] T4 (PR 4) Bloqueo preventivo de emisión (422) en los cuatro casos de aceptación, `CERTIFICATE_EMISSION_BLOCK_DAYS`, OpenAPI y docs.

## Verificación

Se completa al cerrar cada tarea (RED, GREEN, `pnpm verify` en el push).

## Registro de ruta

Inline para exploración (5 lecturas), escritura delegada no disponible desde este agente: se implementa inline por tarea.
