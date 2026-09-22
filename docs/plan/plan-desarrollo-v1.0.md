# Plan de Desarrollo — Plataforma de Facturación Electrónica SIFEN (Paraguay)
 
**Versión:** 1.0
**Alcance:** Plataforma SaaS multi-tenant end-to-end para emisión, firma, envío a SIFEN, KuDE y notificaciones, expuesta como API y como portal web, con modelo de suscripción y white-label.
 
---
 
## 1. Resumen ejecutivo
 
Se construye una plataforma que:
 
1. **Expone un API HTTP** (autenticado por API Key) para que sistemas terceros soliciten la emisión de comprobantes electrónicos, se abstraigan de SIFEN, y reciban webhooks con el resultado.
2. **Provee un portal web** para emisión manual, consulta de comprobantes, dashboards y administración de suscripciones — utilizado por usuarios finales que no cuentan con un ERP propio.
3. **Se ejecuta end-to-end**: genera el XML del DE, lo firma digitalmente con el certificado del emisor, lo envía a SIFEN (sync o async), consulta el resultado, genera el KuDE (PDF con QR), y notifica al receptor por correo y/o WhatsApp.
4. **Es multi-tenant estricto**, con aislamiento reforzado a nivel de base de datos vía **Row Level Security (RLS) de PostgreSQL**.
5. **Se organiza en arquitectura hexagonal (Puertos & Adaptadores)** en un monorepo Node.js/TypeScript, con NestJS en el backend y Next.js en el frontend.
6. **Soporta dos modelos de comercialización**:
   - **White-label / embebido**: otro sistema (ej. gestión de restaurantes) integra el API, el operador final nunca ve la plataforma.
   - **SaaS directo**: PyME o profesional independiente factura desde el portal con una suscripción mensual.
---
 
## 2. Alcance funcional
 
### 2.1 Documentos y operaciones soportadas
 
| Tipo | Código SIFEN | MVP | v1.0 | v1.1 |
|---|---|---|---|---|
| Factura Electrónica (FE) | 1 | ✅ | | |
| Nota de Crédito Electrónica (NCE) | 5 | ✅ | | |
| Nota de Débito Electrónica (NDE) | 6 | ✅ | | |
| Autofactura Electrónica (AFE) | 4 | | ✅ | |
| Nota de Remisión Electrónica (NRE) | 7 | | ✅ | |
| Factura de Exportación / Importación | 2 / 3 | | | ✅ |
| Comprobante de Retención | 8 | | | ✅ |
 
### 2.2 Eventos SIFEN
 
- **Cancelación** (48 h para FE, 168 h para el resto)
- **Inutilización** de rango de numeración (hasta 1000 números por rango)
- **Notificación de recepción, Conformidad, Disconformidad, Desconocimiento, Ajuste** (rol receptor — para clientes que también reciben DTE)
### 2.3 Servicios Web SIFEN a integrar
 
- `siRecepDE` — recepción sincrónica de un DE
- `siRecepLoteDE` — recepción asincrónica de lote (hasta 50 DE, mismo emisor y mismo tipo, mensaje ≤ 1000 KB)
- `siConsLoteDE` — consulta de resultado de lote (polling ≥ 10 min tras envío)
- `siConsDE` — consulta de DE por CDC
- `siRecepEvento` — recepción de eventos
- `siConsRUC` — consulta de RUC (con caché)
Ambientes:
- Test: `sifen-test.set.gov.py`
- Producción: `sifen.set.gov.py`
### 2.4 Notificaciones
 
- **Email** al receptor con XML + KuDE PDF adjuntos, remitente parametrizable por tenant.
- **WhatsApp** (Cloud API de Meta o proveedor tipo Twilio) con link corto al KuDE.
- **Webhooks** al sistema que solicitó la emisión (para el modo API).
El tipo de notificación se parametriza al momento de crear el comprobante mediante un campo `notification.channels: ["email","whatsapp","webhook"]`.
 
---
 
## 3. Arquitectura de alto nivel
 
```
                   ┌──────────────────────────────────────────┐
                   │           Cliente externo (ERP,          │
                   │        POS, sistema de gestión)          │
                   └──────────────┬───────────────────────────┘
                                  │ HTTPS + API Key + Idempotency-Key
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       API Gateway / Ingress                          │
│           (rate limit, autenticación, tenant resolver)               │
└──────────────┬─────────────────────────────────────┬─────────────────┘
               │                                     │
        Portal Web (Next.js)              REST API (NestJS)
        BFF interno (SSR)                 Módulo: emision, admin,
                                          consultas, suscripciones
               │                                     │
               └──────────────┬──────────────────────┘
                              ▼
          ┌──────────────────────────────────────────┐
          │       Núcleo de Dominio (hexagonal)      │
          │ - Emisión DE, firma, KuDE, eventos       │
          │ - Facturación SaaS, auditoría, tenants   │
          └──┬───────────┬─────────────┬─────────────┘
             ▼           ▼             ▼
    ┌──────────────┐ ┌──────────┐ ┌──────────────────┐
    │  PostgreSQL  │ │  Redis   │ │ Object Storage   │
    │ (RLS + audit)│ │ (cache/  │ │ (XML, PDF, cert  │
    │              │ │  BullMQ) │ │ envelope)        │
    └──────────────┘ └──────────┘ └──────────────────┘
             │
             ▼
    ┌────────────────────────────────────────────────┐
    │        Workers (BullMQ / procesos NestJS)      │
    │  · SignAndSubmitWorker (sync/async SIFEN)      │
    │  · PollLoteResultWorker                        │
    │  · KudePdfWorker                               │
    │  · NotificationDispatchWorker                  │
    │  · WebhookDeliveryWorker                       │
    │  · EventSubmissionWorker                       │
    │  · SifenRucCacheRefreshWorker                  │
    └───┬──────────────┬──────────────┬──────────────┘
        ▼              ▼              ▼
    SIFEN WS      Email (SES/       WhatsApp
    (mTLS)        Postmark)         Cloud API
```
 
---
 
## 4. Decisiones tecnológicas
 
| Área | Elección | Justificación |
|---|---|---|
| Runtime | **Node.js 22 LTS + TypeScript** | Obligatorio (librería DNIT es Node.js) |
| Framework backend | **NestJS** | DI nativo, se presta muy bien a hexagonal, módulos, guards, interceptors, OpenAPI |
| Frontend | **Next.js 15 (App Router) + Tailwind + shadcn/ui** | SSR para el BFF del portal, buena DX |
| Monorepo | **Turborepo + pnpm workspaces** | Compartir DTOs, tipos y contratos entre back y front |
| ORM / DB access | **Drizzle ORM** (o Kysely) | Amigables con RLS y transacciones tipadas; Prisma tiene fricción con `SET LOCAL` |
| Base de datos | **PostgreSQL 16** | RLS nativo, particionamiento, JSONB para payloads DE |
| Cache / queues | **Redis 7 + BullMQ** | Encolado con reintentos, DLQ, delays |
| Object storage | **S3 / MinIO** | XML firmados, PDF KuDE, sobres de certificados |
| Firma XML | Librería **`facturacionelectronicapy-xmlgen`** (TIPS-SA) + `xml-crypto` / `xadesjs` | La librería DNIT genera el XML; complementamos con firma XMLDSig Enveloped |
| Cliente SOAP | **`strong-soap`** o cliente HTTP + templates | SIFEN es SOAP 1.2, hay que armar el envelope y hacer mTLS |
| Autenticación mTLS | Node **`https.Agent`** con `pfx`/`cert`+`key` cargados desde KMS | Requisito SIFEN |
| Cifrado de certificados | **AWS KMS / GCP KMS / Vault Transit** (envelope encryption) | Nunca guardar el `.p12` en claro |
| PDF (KuDE) | **`@react-pdf/renderer`** o **Puppeteer + template HTML** | Templates personalizables por tenant |
| QR | **`qrcode`** | Estándar |
| Email | **AWS SES** (o Postmark) + **MJML** para plantillas | |
| WhatsApp | **Meta Cloud API** con webhooks | Nativo, sin intermediarios |
| Pagos suscripción | **Bancard vPOS 2.0 / Pagopar** (locales) + Stripe (extranjero) | El pago del SaaS mismo |
| Autenticación humanos | **Better Auth** o **Keycloak** | MFA, OAuth para SSO empresarial |
| Observabilidad | **OpenTelemetry → Grafana/Tempo/Loki**, **Sentry** | Trazas end-to-end DE → SIFEN |
| Secrets | **Vault / AWS Secrets Manager** | |
| CI/CD | **GitHub Actions**, deploy con **Docker + ECS/GKE** o Fly.io | |
| IaC | **Terraform** | |
 
---
 
## 5. Arquitectura Hexagonal — capas y organización
 
Cada bounded context es un módulo de NestJS con la siguiente estructura:
 
```
src/modules/emision/
├── domain/                       ← Capa de dominio (independiente del framework)
│   ├── entities/
│   │   ├── documento-electronico.entity.ts
│   │   ├── evento.entity.ts
│   │   └── lote.entity.ts
│   ├── value-objects/
│   │   ├── cdc.vo.ts
│   │   ├── ruc.vo.ts
│   │   ├── timbrado.vo.ts
│   │   └── numeracion.vo.ts
│   ├── services/                 ← Domain services (reglas puras)
│   │   ├── numeracion.service.ts
│   │   └── cdc-generator.service.ts
│   ├── events/                   ← Domain events
│   │   ├── documento-firmado.event.ts
│   │   └── documento-aprobado.event.ts
│   └── ports/                    ← Interfaces (contratos)
│       ├── sifen.gateway.ts
│       ├── xml-signer.port.ts
│       ├── certificate-store.port.ts
│       ├── documento.repository.ts
│       └── kude-renderer.port.ts
│
├── application/                  ← Casos de uso (orquestación)
│   ├── commands/
│   │   ├── emitir-factura.command.ts
│   │   ├── cancelar-documento.command.ts
│   │   └── inutilizar-rango.command.ts
│   ├── queries/
│   │   ├── obtener-documento.query.ts
│   │   └── listar-documentos.query.ts
│   └── handlers/
│       ├── emitir-factura.handler.ts
│       └── ...
│
├── infrastructure/               ← Adaptadores (dependen de dominio)
│   ├── adapters/
│   │   ├── sifen/                ← Cliente SOAP mTLS
│   │   │   ├── sifen-soap.gateway.ts
│   │   │   └── envelopes/
│   │   ├── xmlgen/               ← Adaptador de la librería DNIT
│   │   │   └── xmlgen-de-builder.ts
│   │   ├── signing/              ← Firma XMLDSig
│   │   │   └── xades-signer.adapter.ts
│   │   ├── kude/
│   │   │   └── react-pdf.renderer.ts
│   │   ├── kms/
│   │   │   └── aws-kms.certificate-store.ts
│   │   └── persistence/
│   │       ├── documento.postgres.repository.ts
│   │       └── mappers/
│   ├── controllers/              ← Adaptadores de entrada
│   │   ├── documentos.controller.ts       (REST API pública)
│   │   ├── documentos-portal.controller.ts (BFF portal)
│   │   └── workers/                       (subscribers de queue)
│   └── mappers/
│
└── emision.module.ts
```
 
### 5.1 Puertos principales
 
```typescript
// domain/ports/sifen.gateway.ts
export interface SifenGateway {
  enviarDESincronico(xmlFirmado: string, dId: string): Promise<SifenSyncResponse>;
  enviarLote(xmlsFirmados: string[], dId: string): Promise<SifenLoteReceiptResponse>;
  consultarLote(nroLote: string): Promise<SifenLoteResultResponse>;
  consultarDE(cdc: string): Promise<SifenConsDEResponse>;
  enviarEvento(eventoXmlFirmado: string, dId: string): Promise<SifenEventoResponse>;
  consultarRUC(ruc: string): Promise<SifenConsRUCResponse>;
}
 
// domain/ports/xml-signer.port.ts
export interface XmlSigner {
  sign(xml: string, certificate: LoadedCertificate): Promise<string>;
}
 
// domain/ports/certificate-store.port.ts
export interface CertificateStore {
  loadForTenant(tenantId: TenantId, alias?: string): Promise<LoadedCertificate>;
  store(tenantId: TenantId, p12: Buffer, passphrase: string, alias: string): Promise<void>;
  rotate(tenantId: TenantId, alias: string): Promise<void>;
}
 
// domain/ports/kude-renderer.port.ts
export interface KudeRenderer {
  render(dte: DocumentoTributarioElectronico, tenantBranding: TenantBranding): Promise<Buffer>;
}
```
 
Los adaptadores nunca son referenciados directamente desde el dominio o la aplicación — solo se resuelven vía DI de NestJS a partir de la interfaz.
 
---
 
## 6. Bounded Contexts
 
| BC | Responsabilidad | Módulo NestJS |
|---|---|---|
| **Identity & Access** | Tenants, usuarios humanos, API keys, roles y permisos, sesiones | `identity` |
| **Tenant Configuration** | RUC, razón social, actividades económicas, establecimientos, puntos de expedición, timbrados, CSC, branding, plantillas | `tenant-config` |
| **Certificate Management** | Alta, custodia (KMS), rotación y validación de certificados X.509 de cada tenant | `certificates` |
| **Emisión (Core)** | Generación de DE, firma, envío a SIFEN, gestión del ciclo de vida, KuDE, eventos | `emision` |
| **Numeración** | Asignación atómica de `dNumDoc` por (timbrado, est., punto exp., tipo), gestión de series (AA–ZZ), inutilizaciones | `numeracion` |
| **Consulta / Reporting** | Búsquedas, filtros, dashboards, exportaciones | `consulta` |
| **Notifications** | Envío por email, WhatsApp, webhooks; plantillas por tenant; reintentos | `notifications` |
| **Billing (SaaS)** | Planes, suscripciones, cuotas de uso, facturación del propio SaaS, pagos | `billing` |
| **Audit** | Log inmutable, append-only, con hash chain opcional | `audit` |
| **Admin / Operaciones** | Panel interno del operador SaaS, herramientas de soporte, reprocesos manuales | `ops` |
 
---
 
## 7. Modelo de datos multi-tenant con RLS
 
### 7.1 Estrategia
 
- **Shared DB, shared schema** (un solo Postgres, un solo schema).
- Toda tabla operativa tiene `tenant_id UUID NOT NULL`.
- Se activan **RLS Policies** para que ninguna consulta pueda ver filas de otro tenant, aún si la app se equivoca.
- El backend hace `SET LOCAL app.current_tenant = '<uuid>'` al inicio de **cada transacción**, dentro de un `TenantScopedTransaction` interceptor de NestJS.
- El **rol de aplicación** de Postgres no tiene `BYPASSRLS`. Existe un rol separado `platform_admin` con `BYPASSRLS` solo para tareas administrativas (jobs cross-tenant, soporte).
```sql
-- Ejemplo para tabla de documentos
CREATE TABLE documentos_electronicos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  cdc CHAR(44) NOT NULL,
  tipo_documento SMALLINT NOT NULL,
  numero_timbrado CHAR(8) NOT NULL,
  establecimiento CHAR(3) NOT NULL,
  punto_expedicion CHAR(3) NOT NULL,
  numero_documento CHAR(7) NOT NULL,
  serie CHAR(2),
  estado VARCHAR(32) NOT NULL,
  ruc_emisor VARCHAR(15) NOT NULL,
  ruc_receptor VARCHAR(15),
  fecha_emision TIMESTAMPTZ NOT NULL,
  fecha_aprobacion_sifen TIMESTAMPTZ,
  monto_total NUMERIC(15,2) NOT NULL,
  moneda CHAR(3) NOT NULL,
  payload_original JSONB NOT NULL,
  xml_firmado_url TEXT,
  kude_pdf_url TEXT,
  respuesta_sifen JSONB,
  idempotency_key VARCHAR(120),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, cdc),
  UNIQUE (tenant_id, idempotency_key)
);
 
CREATE INDEX ON documentos_electronicos (tenant_id, estado, created_at DESC);
CREATE INDEX ON documentos_electronicos (tenant_id, ruc_receptor);
 
ALTER TABLE documentos_electronicos ENABLE ROW LEVEL SECURITY;
ALTER TABLE documentos_electronicos FORCE ROW LEVEL SECURITY;
 
CREATE POLICY tenant_isolation ON documentos_electronicos
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
```
 
### 7.2 Tablas principales (resumen)
 
**Identity & Tenancy**
- `tenants (id, business_name, ruc, dv, status, plan_id, timezone, created_at, ...)`
- `users (id, tenant_id, email, password_hash, mfa_secret, ...)`
- `memberships (id, tenant_id, user_id, role)` — un usuario puede pertenecer a varios tenants (útil para contadores).
- `api_keys (id, tenant_id, hashed_key, prefix, scopes[], last_used_at, expires_at, revoked_at, created_by)` — la clave se guarda hasheada (Argon2id) y se muestra al usuario solo una vez.
- `sessions (id, user_id, expires_at, ip, user_agent)`
**Tenant Config**
- `establecimientos (id, tenant_id, codigo, nombre, direccion, telefono, ...)`
- `puntos_expedicion (id, tenant_id, establecimiento_id, codigo)`
- `timbrados (id, tenant_id, numero, fecha_inicio, fecha_fin, tipo_documento, estado)`
- `csc_codes (id, tenant_id, id_csc, csc_valor_cifrado, ambiente, activo)`
- `tenant_branding (tenant_id, logo_url, colores, plantilla_kude, remitente_email, whatsapp_business_id, ...)`
**Numeración**
- `numeracion_secuencial (tenant_id, timbrado, est, pto_exp, tipo_doc, serie, ultimo_numero)` — con `UNIQUE` compuesto, actualizada con `SELECT ... FOR UPDATE` o `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`.
- `rangos_inutilizados (id, tenant_id, timbrado, est, pto_exp, tipo_doc, desde, hasta, motivo, evento_id)`.
**Certificados**
- `certificates (id, tenant_id, alias, subject, serial, ruc, valid_from, valid_to, kms_key_id, ciphertext_ref, fingerprint, revoked, created_at)`.
**Documentos & Eventos**
- `documentos_electronicos` (ver arriba)
- `lotes_sifen (id, tenant_id, dId, numero_lote_sifen, estado, cant_documentos, enviado_at, procesado_at)`
- `documento_lote (documento_id, lote_id)`
- `eventos_sifen (id, tenant_id, documento_id, tipo, xml_firmado_url, respuesta_sifen, estado, firmado_at)`
**Notifications**
- `notification_dispatches (id, tenant_id, documento_id, canal, destino, estado, intentos, ultimo_error, enviado_at)`
- `webhook_endpoints (id, tenant_id, url, secret_hmac, eventos[], activo)`
- `webhook_deliveries (id, tenant_id, endpoint_id, evento, payload, status_code, intento, siguiente_reintento_at)`
**Billing (para la suscripción del propio SaaS)**
- `plans (id, name, moneda, precio_mensual, limite_documentos_mes, limite_api_calls_mes, features JSONB)`
- `subscriptions (id, tenant_id, plan_id, estado, fecha_inicio, fecha_fin, proximo_cobro, metodo_pago_id)`
- `payment_methods (id, tenant_id, tipo, token_pasarela, ultimos_4, expiracion)`
- `invoices_saas (id, tenant_id, subscription_id, periodo, monto, estado, fecha_emision, pdf_url)` — facturas del **propio SaaS** hacia el tenant, no confundir con los DE que emite el tenant.
- `usage_counters (tenant_id, periodo, documentos_emitidos, api_calls, notificaciones_enviadas)`
**Auditoría**
- `audit_events (id, tenant_id, actor_type, actor_id, accion, entidad, entidad_id, before JSONB, after JSONB, ip, user_agent, occurred_at, prev_hash, hash)` — append-only, con encadenamiento SHA-256 para detectar manipulación.
---
 
## 8. Flujos principales
 
### 8.1 Emisión sincrónica (caso más común, 1 DE por vez)
 
```
1. Cliente → POST /v1/documents  (Api-Key, Idempotency-Key, body)
2. API valida API Key → resuelve tenant_id → SET LOCAL app.current_tenant
3. Rate-limit por tenant (Redis)
4. Validación de esquema (Zod/class-validator) del payload
5. UseCase EmitirFacturaHandler:
   a. Chequea idempotencia (unique key)
   b. Toma número de documento (numeracion.service, transacción con FOR UPDATE)
   c. Construye JSON canónico para xmlgen y llama a la librería DNIT
   d. Firma XML (XmlSigner, certificado desde CertificateStore)
   e. Persiste DE en estado "signed"
   f. Encola SignAndSubmitJob
6. API responde 202 Accepted con document_id y CDC (el CDC se conoce apenas se firma)
7. Worker toma el job:
   a. Llama a SifenGateway.enviarDESincronico
   b. Parsea respuesta:
      - 0260 (aprobado) → estado "approved"
      - 0261 (aprobado con observación) → estado "approved_with_warnings"
      - rechazo → estado "rejected" + código y motivo
   c. Genera KuDE PDF, guarda en S3
   d. Publica evento DocumentoAprobado / DocumentoRechazado
8. Suscriptores:
   - NotificationDispatchWorker → email + WhatsApp al receptor
   - WebhookDeliveryWorker → POST al sistema que emitió (HMAC firmado)
```
 
**¿Por qué 202 y no 200?** Porque SIFEN puede tardar. Devolvemos 202 con la URL de polling `GET /v1/documents/{id}` y también notificamos por webhook. Para clientes que necesiten respuesta bloqueante ofrecemos un modo `?wait=true` con timeout de 30 s (long-polling interno).
 
### 8.2 Emisión asincrónica (batch / alto volumen)
 
- Se acumulan DE del mismo emisor y mismo tipo hasta 50 o hasta un `flush_interval` (ej. 30 s).
- Se arma el lote comprimido y se envía a `siRecepLoteDE`.
- Se guarda `numero_lote_sifen`.
- Un `PollLoteResultWorker` con delay inicial de 10 min y reintentos cada 10 min consulta `siConsLoteDE`.
- Al recibir el resultado se disparan los mismos eventos que en el flujo sincrónico por cada DE del lote.
**Reglas críticas del lote (según Guía de Mejores Prácticas):**
- Un solo RUC emisor por lote.
- Un solo tipo de documento por lote.
- ≤ 50 DE.
- Mensaje SOAP total ≤ 1000 KB.
- Nunca reenviar el mismo CDC hasta tener respuesta definitiva.
- Nunca reenviar el mismo lote.
Estas reglas se encapsulan en `LoteBuilder` como invariantes de dominio; violarlas es un bug interno, no un error del usuario.
 
### 8.3 Cancelación
 
```
POST /v1/documents/{cdc}/cancel  { motivo }
→ Valida plazo (48h FE / 168h otros) contra fecha_aprobacion_sifen
→ Genera XML de evento gCancelacion, firma
→ Envía a siRecepEvento
→ Actualiza estado del DE original a "cancelled" si SIFEN aprueba
→ Dispara notificación de cancelación al receptor
```
 
### 8.4 Inutilización de rango
 
```
POST /v1/numbering/inutilize
{ timbrado, establecimiento, punto_expedicion, tipo, desde, hasta, motivo }
→ Valida (hasta - desde ≤ 1000)
→ Valida que ningún número del rango tenga DTE aprobado
→ Genera evento gInutilizacion, firma, envía
→ Marca el rango en rangos_inutilizados
```
 
### 8.5 Contingencia
 
- Si SIFEN está indisponible >5 min, se activa modo contingencia:
  - `iTipEmi = 2` en el DE.
  - El KuDE se genera y entrega al receptor de inmediato.
  - Se encola en cola de "pendientes de contingencia" para reintento.
  - Se avisa por dashboard y por webhook a los clientes API.
- Circuit breaker (Opossum) con tres estados: closed / open / half-open, gatillado por métricas de error de SIFEN.
- **Manejo del bloqueo por RUC (10–60 min)**: si detectamos código de bloqueo, se pausan envíos de ese tenant específico durante el intervalo indicado y se reencolan con delay.
### 8.6 Flujo de firma digital
 
```
LoadedCertificate ← CertificateStore.loadForTenant(tenantId)
  ├─ Lee metadatos de tabla `certificates`
  ├─ Lee ciphertext de S3 (envelope encryption con KMS)
  ├─ Descifra la data key con KMS
  ├─ Descifra el .p12 en memoria (nunca escribir a disco)
  └─ Parsea con node-forge → { cert, privateKey }
 
XmlSigner (xadesjs / xml-crypto)
  ├─ Canonicaliza (C14N Exclusive)
  ├─ Genera DigestValue (SHA-256)
  ├─ SignatureValue (RSA-SHA256, 2048 bits)
  └─ Enveloped signature dentro del nodo <rDE> apropiado
```
 
El **buffer del certificado descifrado nunca se persiste** ni se loguea; el descifrado ocurre por request de firma, se puede cachear en memoria por N minutos con TTL corto para performance, en un LRU cache limitado.
 
---
 
## 9. Seguridad
 
### 9.1 API Keys
 
- Formato: `sk_live_xxxxxxxx.` + 40 chars aleatorios (`base32`). Prefijo visible para trazabilidad, resto secreto.
- Almacenamiento: `hashed_key = argon2id(secret)`. Nunca en claro.
- Scopes: `documents:write`, `documents:read`, `events:write`, `webhooks:manage`, etc.
- Rotación: cada tenant puede tener hasta N claves activas; UI para revocar y crear.
- Rate limit por clave (Redis sliding window) + límites por plan.
- Headers requeridos: `Authorization: Bearer <api_key>`, `Idempotency-Key`.
### 9.2 Certificados X.509
 
- Subidos vía UI o API en `.p12` + passphrase.
- **Envelope encryption**: se genera una data key con KMS (AWS KMS / GCP KMS / Vault Transit), se cifra el `.p12` con esa data key (AES-256-GCM), se guarda el ciphertext en S3 y solo el KEK ID en Postgres.
- Al firmar, se pide a KMS descifrar la data key, se descifra el `.p12` en memoria.
- Monitor de vencimiento: 60/30/7 días antes se envían alertas por email al tenant.
- Validación de que el `SerialNumber` / `SubjectAlternativeName` del certificado contiene el RUC del tenant.
### 9.3 CSC
 
- El CSC se cifra en la BD con `pgcrypto` + clave maestra en KMS.
- Puede haber hasta 2 CSC activos por tenant (SIFEN lo permite).
### 9.4 RLS + defensa en profundidad
 
1. La app **debe** setear `app.current_tenant` — enforced por `TenantContextInterceptor`.
2. Postgres **hace cumplir** el aislamiento con `FORCE ROW LEVEL SECURITY`.
3. Tests de contrato: se corre un test que intenta leer datos de otro tenant y debe fallar.
### 9.5 Firma de webhooks
 
- Cada endpoint tiene un `secret_hmac` único.
- Cada delivery incluye `X-Signature: sha256=<hmac(secret, timestamp + body)>` y `X-Timestamp`.
- El cliente valida y protege contra replay (rechazar > 5 min).
### 9.6 Auditoría
 
- Toda operación de escritura pasa por un `AuditingInterceptor` que emite un evento a `audit_events`.
- Se registran: quién (user_id o api_key_id), qué acción, sobre qué entidad, `before`/`after` (redactando campos sensibles).
- Encadenamiento hash: `hash = sha256(prev_hash || row_json)`. Permite verificación posterior de integridad.
### 9.7 Otros
 
- HTTPS forzado, HSTS.
- Content Security Policy estricto en el portal.
- CORS restringido por tenant configurable.
- Secretos en Vault, nunca en variables de entorno commiteadas.
- Escaneo de dependencias (Snyk / Socket).
- SAST + DAST en CI.
---
 
## 10. Notificaciones
 
### 10.1 Contrato de la API
 
```json
POST /v1/documents
{
  "tipo_documento": "factura_electronica",
  "receptor": { ... },
  "items": [...],
  "totales": {...},
  "notificaciones": {
    "canales": ["email", "whatsapp"],
    "email": {
      "destinatarios": ["cliente@empresa.com"],
      "cc": [],
      "template_id": "default"
    },
    "whatsapp": {
      "telefono": "+595981123456"
    }
  },
  "webhook": {
    "enabled": true,
    "url_override": null
  }
}
```
 
Si el campo `notificaciones` se omite, se aplica la política por defecto configurada por el tenant.
 
### 10.2 Templates
 
- Plantillas por tenant, con MJML (email) y plantillas de mensaje aprobadas en Meta WhatsApp Business.
- Variables interpoladas: `{{razon_social_emisor}}`, `{{numero_documento}}`, `{{total}}`, `{{link_kude}}`, etc.
- Se guardan **materializadas** por notificación (para reproducir exactamente lo enviado).
### 10.3 Reintentos
 
Backoff exponencial: 30s, 2m, 10m, 1h, 4h, 12h, 24h. Después → dead-letter queue + alerta al tenant en el portal.
 
### 10.4 White-label
 
- El remitente de email es configurable por tenant (con validación de SPF/DKIM del dominio del tenant vía SES).
- El número de WhatsApp puede ser el del tenant (WABA propio) o el número compartido de la plataforma.
- Templates de correo con branding del tenant (logo, colores, footer legal).
---
 
## 11. Modelo de suscripciones (SaaS)
 
### 11.1 Planes
 
| Plan | Documentos/mes incluidos | Usuarios | WhatsApp | Retención XML | Precio |
|---|---|---|---|---|---|
| Free / Trial | 30 | 1 | ❌ | 6 meses | Gratis 30 días |
| Starter | 300 | 3 | ✅ (compartido) | 1 año | Gs |
| Pro | 3.000 | 10 | ✅ (compartido) | 5 años | Gs |
| Business | 15.000 | ilimitado | ✅ (propio) | 10 años | Gs |
| Enterprise / API-only | Custom | — | ✅ (propio) | 10 años + backup | Custom |
 
### 11.2 Facturación del SaaS
 
- Bancard vPOS 2.0 y Pagopar para tarjetas locales.
- Cobros recurrentes con `payment_methods.token_pasarela`.
- Reintentos automáticos, dunning, notificaciones.
- Emisión de la propia factura al tenant **también usando la plataforma** (dogfooding): el tenant "plataforma" tiene su propio RUC, su timbrado, y emite FE hacia sus clientes tenants.
- Overage: si el tenant supera el cupo, se cobra por documento adicional según el plan (o se le pausa la emisión, configurable).
### 11.3 Cuotas y throttling
 
- `usage_counters` se actualiza atómicamente en cada emisión.
- Al 80% del cupo se avisa por email/portal.
- Al 100% se aplica la política: bloquear, overage, o upgrade auto.
---
 
## 12. Escalabilidad y resiliencia
 
- **Stateless**: API y workers son procesos idénticos y horizontalmente escalables.
- **Colas separadas** por prioridad y tipo: `sifen-submit`, `sifen-poll`, `notification-email`, `notification-wa`, `webhook-delivery`, `kude-render`. Cada una con concurrencia y rate limits propios.
- **Rate limit per-tenant** aplicado en el gateway, y **rate limit hacia SIFEN** aplicado en cliente (evitar el bloqueo de RUC).
- **Circuit breaker** por endpoint SIFEN.
- **Backpressure**: si BullMQ crece por encima de umbral, la API devuelve 503 con `Retry-After` a nuevas peticiones no-esenciales.
- **Particionamiento** de `documentos_electronicos` por mes (Postgres declarative partitioning) para mantener índices manejables.
- **Read replica** de Postgres para el módulo de reportes/dashboards.
- **Object storage** con lifecycle policy (mover a Glacier tras 1 año, borrar tras 10 años cumpliendo obligación fiscal).
- **Multi-AZ** en producción; **backups PITR** cada 5 min.
---
 
## 13. Observabilidad
 
- **Tracing distribuido** (OpenTelemetry): un `trace_id` acompaña al DE desde que ingresa el request hasta que se envía la notificación.
- **Métricas clave** (Prometheus):
  - `sifen_submissions_total{tipo,resultado,ambiente}`
  - `sifen_response_latency_seconds`
  - `sifen_rejections_total{codigo}`
  - `documentos_por_estado`
  - `queue_depth{queue}`
  - `notifications_delivered_total{canal,resultado}`
- **Logs estructurados** JSON, con `tenant_id`, `document_id`, `cdc`, `trace_id`.
- **Alertas**: SIFEN caído >2 min, tasa de rechazo >5%, cola creciendo >X, cert por vencer.
- **Sentry** para excepciones del backend y frontend.
- **Dashboard interno** (Grafana) + **dashboard por tenant** en el portal (sus propias métricas).
---
 
## 14. Portal web (Next.js)
 
### 14.1 Áreas
 
- **Login / MFA**
- **Dashboard**: KPIs (documentos emitidos por período, monto total facturado, tasa de aprobación, top clientes, alertas).
- **Emisión manual**: formulario multi-paso para crear FE/NCE/NDE/AFE/NRE.
- **Listado y detalle** de documentos: filtros por estado, tipo, fecha, receptor; descarga XML/KuDE; reenvío de notificaciones; cancelación.
- **Numeración**: gestión de timbrados, establecimientos, puntos de expedición; solicitud de inutilizaciones.
- **Certificados**: alta, monitoreo de vencimiento, rotación.
- **Notificaciones**: bandeja con estado, reintentos manuales, plantillas.
- **Webhooks**: endpoints, secret, historial de deliveries.
- **API Keys**: alta, revocación, scopes.
- **Suscripción y facturación**: plan actual, uso, método de pago, historial.
- **Auditoría**: log filtrable.
- **Configuración del tenant**: branding, remitentes, ambiente (test/prod).
### 14.2 White-label mode
 
- El portal puede correr bajo dominio propio del tenant (CNAME) con branding total → para clientes Enterprise que quieran ofrecerlo a sus propios clientes.
---
 
## 15. Testing
 
### 15.1 Estrategia
 
- **Unit tests** (Vitest): dominio y casos de uso, sin infra. Cobertura mínima 85% en `domain/` y `application/`.
- **Integration tests**: adaptadores contra Postgres real (testcontainers), Redis real, S3 (MinIO).
- **Contract tests**: contra un mock SOAP local que reproduce los WSDL de SIFEN y devuelve casos de rechazo/aprobación conocidos.
- **E2E** (Playwright): flujos completos en el portal.
- **Compliance tests con SIFEN Test real**: batería obligatoria de la Guía de Pruebas de e-kuatia:
  - 5 FE, 5 NCE, 5 NDE, 5 AFE, 5 NRE aprobadas por sincrónico ✓
  - Mismos volúmenes rechazados ✓
  - Lotes asincrónicos aprobados y rechazados ✓
  - 5 cancelaciones, 5 inutilizaciones ✓
  - Consulta DE por CDC ✓
  - Generación KuDE + validación QR ✓
- **Tests de aislamiento multi-tenant**: intento explícito de acceso cross-tenant debe fallar tanto por app como por BD.
- **Load tests** (k6): 100 req/s sostenido, picos de 500 req/s.
- **Chaos tests**: caída de SIFEN, caída de Redis, latencia de KMS.
### 15.2 Datos de prueba
 
- Ambiente `staging` conectado a `sifen-test.set.gov.py`.
- Certificados de prueba (auto-generados y reales de PSC para el conjunto de escenarios).
- CSC de prueba: `IdCSC 0001 / CSC ABCD0000000000000000000000000000`.
---
 
## 16. Roadmap por fases
 
### Fase 0 — Preparación (2 semanas)
- Setup del monorepo, CI/CD, infra base (VPC, Postgres, Redis, S3, KMS).
- Convenciones de código, ADRs, plantilla de módulo hexagonal.
- Registro como facturador electrónico en DNIT para la propia compañía (necesario para el dogfooding y pruebas oficiales).
- Onboarding con la librería `facturacionelectronicapy-xmlgen`: escribir el adaptador y probar contra ambiente de test SIFEN.
### Fase 1 — MVP funcional (6-8 semanas)
- Identity, Tenant Config, Certificates.
- Emisión sincrónica de **FE, NCE, NDE**.
- Numeración.
- KuDE PDF + QR.
- SIFEN test (sync).
- Notificación por email.
- Webhooks básicos.
- Portal mínimo: login, emisión manual, listado, detalle, descargas.
- Auditoría base.
- Tests de compliance mínima con SIFEN test.
**Salida:** Poder facturar FE en test end-to-end con 1 cliente piloto (interno).
 
### Fase 2 — Producción y ampliación (6 semanas)
- Alta en producción SIFEN.
- Envío asincrónico por lotes.
- **AFE y NRE**.
- Eventos: cancelación, inutilización.
- Contingencia + circuit breaker.
- Notificación por WhatsApp.
- Dashboard con KPIs.
- Rate limiting y cuotas por plan.
- Módulo Billing con Bancard/Pagopar.
- Panel de operaciones interno.
**Salida:** Producción con 3-5 clientes piloto (uno de ellos, el sistema de restaurantes propio).
 
### Fase 3 — Escalamiento y white-label (4-6 semanas)
- White-label: CNAME propio, branding personalizado por tenant.
- Plantillas de KuDE personalizables.
- SSO empresarial (SAML/OIDC) para Enterprise.
- Multi-región (si aplica).
- Módulos avanzados: reportes fiscales, exportaciones, integración con contabilidad.
- Marketplace de integraciones (n8n, Zapier, ERPs comunes).
### Fase 4 — Roadmap continuo
- Factura de Exportación / Importación.
- Comprobante de Retención.
- Eventos de rol receptor (conformidad, disconformidad, desconocimiento).
- Consulta pública tipo "e-kuatia" para receptores no facturadores.
- App móvil (React Native) para emisión rápida.
---
 
## 17. Estimación de equipo
 
Para las Fases 0-2 (MVP → Producción, ~14-16 semanas):
 
| Rol | Cantidad | Responsabilidad |
|---|---|---|
| Tech Lead / Arquitecto | 1 | Diseño, revisiones, ADRs |
| Backend Sr (Node/NestJS) | 2 | Core dominio, SIFEN, firma |
| Backend Ssr | 1 | Notificaciones, billing, webhooks |
| Frontend Sr (Next.js) | 1 | Portal + BFF |
| Frontend Ssr | 1 | Portal (features) |
| DevOps / SRE | 1 | Infra, CI/CD, observabilidad |
| QA con foco SIFEN | 1 | Compliance tests, automatización |
| PM / PO | 0.5 | Priorización, contacto con DNIT |
| UX/UI | 0.5 | Portal, KuDE, emails |
 
---
 
## 18. Riesgos y mitigaciones
 
| Riesgo | Impacto | Probabilidad | Mitigación |
|---|---|---|---|
| SIFEN cambia el Manual Técnico | Alto | Media | Adapter aislado, versionado del XML gen; suscripción a notas técnicas de DNIT |
| Bloqueo temporal de RUC por errores masivos | Medio | Media | Circuit breaker por tenant + validaciones estrictas pre-envío |
| Vencimiento silencioso de certificado del cliente | Alto | Alta | Monitor con 3 alertas + bloqueo preventivo D-1 |
| Fuga de certificado / clave privada | Crítico | Baja | KMS + auditoría de accesos + nunca en disco/logs |
| Vulneración de RLS por bug de la app | Crítico | Baja | `FORCE ROW LEVEL SECURITY`, rol sin BYPASSRLS, tests de aislamiento |
| SIFEN Producción down por >1 h | Alto | Media | Modo contingencia, comunicación pre-armada, cola persistente |
| Costo de WhatsApp Business escala | Medio | Media | Cargar como overage al plan del tenant o exigir WABA propio a partir de N mensajes |
| Latencia de firma en volumen | Medio | Media | Cache LRU de certificados descifrados (TTL corto), pool de workers dedicados |
| Cambios regulatorios (nuevos DE) | Medio | Alta | Diseño abierto por `tipo_documento` y estrategia por builder; releases mensuales |
| Duplicación de CDC en reintentos | Alto | Baja | Idempotencia estricta + guardar CDC apenas se firma + consulta previa antes de reenviar |
 
---
 
## 19. Contratos de API (esbozo)
 
```
POST   /v1/documents                   Emitir DE (FE/NCE/NDE/AFE/NRE)
GET    /v1/documents                   Listar (filtros: tipo, estado, desde, hasta, receptor)
GET    /v1/documents/{id}              Detalle
GET    /v1/documents/{id}/xml          Descargar XML firmado
GET    /v1/documents/{id}/kude         Descargar KuDE PDF
POST   /v1/documents/{cdc}/cancel      Cancelación
POST   /v1/documents/{id}/resend       Reenviar notificaciones
POST   /v1/numbering/inutilize         Inutilizar rango
GET    /v1/numbering/status            Ver numeración actual
 
POST   /v1/webhooks                    Alta endpoint
GET    /v1/webhooks
DELETE /v1/webhooks/{id}
POST   /v1/webhooks/{id}/test
 
POST   /v1/api-keys                    (solo portal)
DELETE /v1/api-keys/{id}
 
GET    /v1/usage                       Uso del período actual
 
GET    /v1/receivers/{ruc}             Consulta de RUC (proxy cacheado a siConsRUC)
```
 
**Eventos webhook emitidos:**
 
```
document.created
document.signed
document.submitted
document.approved
document.approved_with_warnings
document.rejected
document.cancelled
document.notification.delivered
document.notification.failed
lote.processed
event.approved
event.rejected
```
 
Payload de ejemplo:
 
```json
{
  "id": "evt_01HZ...",
  "type": "document.approved",
  "created_at": "2026-09-22T14:30:00-03:00",
  "tenant_id": "tnt_...",
  "data": {
    "document_id": "doc_...",
    "cdc": "01800695631001001000000012024010112345678901234",
    "tipo": "factura_electronica",
    "numero": "001-001-0000001",
    "estado": "approved",
    "fecha_aprobacion_sifen": "2026-09-22T14:29:57-03:00",
    "urls": {
      "xml": "https://.../xml",
      "kude": "https://.../kude.pdf"
    }
  }
}
```
 
---
 
## 20. Consideraciones legales y de compliance
 
- **Ley 4.017/2010** de Firma Digital.
- **Decreto 7.795/2017** creación de SIFEN, y **Decreto 872/2023** de ampliación.
- **Resoluciones DNIT** vigentes (nombramiento como facturador electrónico, obligaciones).
- **Ley 6.534** de Protección de Datos Personales (Paraguay) — DPO, aviso de privacidad, tratamiento de datos del receptor.
- **Retención mínima** de DTE por el plazo tributario vigente (10 años); nuestra plataforma retiene por defecto según plan.
- El KuDE debe cumplir el formato del capítulo 13 del Manual Técnico v150 (encabezado obligatorio, ítems, subtotales, información de consulta, QR).
---
 
## 21. Próximos pasos inmediatos
 
1. **Semana 1**: Registro como facturador electrónico ante DNIT para el ambiente de test. Obtención de certificado de prueba de un PSC habilitado. Solicitud del CSC.
2. **Semana 1-2**: PoC del adaptador de la librería `facturacionelectronicapy-xmlgen` + firma XMLDSig + envío sincrónico a `sifen-test`, generando 1 FE aprobada end-to-end desde un script.
3. **Semana 2**: Aprobación del stack, IaC inicial, monorepo esqueleto.
4. **Semana 3**: Kickoff Fase 1 con backlog priorizado.
---
 
*Fin del documento.*