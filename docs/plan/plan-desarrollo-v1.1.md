# Plan de Desarrollo — Plataforma de Facturación Electrónica SIFEN (Paraguay)

**Versión:** 1.1 (corrige la v1.0 contra la documentación oficial)
**Alcance:** Plataforma SaaS multi-tenant end-to-end para emisión, firma, envío a SIFEN, KuDE y notificaciones, expuesta como API y como portal web, con modelo de suscripción y white-label.

---

## 0. Fuentes y control de cambios

### 0.1 Documentación de referencia (orden de precedencia)

| # | Documento | Fecha | Uso |
|---|---|---|---|
| 1 | Notas técnicas vigentes (portal DNIT e-kuatia) | — | **Pendiente de revisar.** Prevalecen sobre el MT |
| 2 | Guía de Pruebas para el Sistema e-kuatia (DNIT) | Feb/2026 | Datos de prueba y batería mínima de homologación |
| 3 | Recomendaciones y mejores prácticas para SIFEN — Guía para el desarrollador | Oct/2024 | Lotes, bloqueos, consulta de lotes |
| 4 | Manual Técnico SIFEN v150 (MD5 `25EB165A8506EFA3A255B863ABCCAE95`) | Sep/2019 | Formato, WS, validaciones, eventos, KuDE, QR |
| 5 | Estructura xml_DE (ejemplo oficial de DE firmado) | — | Referencia de firma y QR |
| 6 | XSD oficiales publicados en `http://ekuatia.set.gov.py/sifen/xsd` | — | Validación pre-envío |

> Regla: cuando dos documentos se contradicen, se aplica el más reciente y se confirma con el **Prevalidador SIFEN** (`https://ekuatia.set.gov.py/prevalidador/`) antes de codificar.
>
> El archivo "Estructura_DE xsd" que circula junto a la documentación **no corresponde a v150** (usa grupos como `dIDE`, `gCiODE`, `iAmbDE`, `gDTim`, `gCamOC`, campos de ISC). No se usa para validar. Se usan los XSD oficiales `*_v150.xsd`.

### 0.2 Cambios respecto de la v1.0

| Tema | v1.0 decía | v1.1 dice | Fuente |
|---|---|---|---|
| Justificación de Node | "Obligatorio, librería DNIT" | Elección pragmática: ecosistema TIPS S.A. (MIT, comunidad). El MT permite cualquier lenguaje | MT §8; repo TIPS |
| Firma | xmlgen + xml-crypto / xadesjs | XMLDSig enveloped simple; se evalúa `facturacionelectronicapy-xmlsign`. Sin XAdES | MT §7.6–7.7 |
| Contingencia | `iTipEmi = 2` automático | No existe en esta etapa (validación 1050). Cola + reintento dentro de las 72 h | MT §14, val. 1050, §6.2 |
| Modo de envío principal | Sincrónico | **Lote asincrónico** como camino principal; sincrónico sujeto a habilitación del RUC (val. 1264) | Guía 2024; MT val. 1264 |
| Consulta de lote | Polling a 10 min | Se mantiene (≥10 min) + puede tardar 1–24 h + código 0364 pasadas 48 h → consulta por CDC | Guía 2024 |
| Recuperación sin respuesta | — | Consultar el lote usando un CDC enviado en él | Guía 2024 |
| Estados de respuesta | Códigos 0260/0261 | Estado derivado de `dEstRes`; 0261 no figura en la documentación | MT Schema XML 4 |
| Reenvío de CDC | "Nunca reenviar el mismo CDC" | Nunca sin respuesta definitiva. Tras rechazo: mismo CDC si la corrección no altera sus campos; si los altera, inutilizar y numerar de nuevo | MT §6.5; Guía 2024 |
| Tipos de DE en MVP | FE, NCE, NDE | FE, NCE, NDE, **AFE y NRE** (la homologación exige los cinco) | Guía de Pruebas 2026 |
| Eventos de receptor | v1.1 / Fase 4 | Antes de homologación (la batería los exige) | Guía de Pruebas 2026 |
| "Ajuste" como evento de receptor | Sí | No: Devolución y Ajuste es automático de SIFEN al aprobar NC/ND | MT §11.1.3 |
| Eventos | Uno por envío | Lotes de hasta 15 eventos por `siRecepEvento` | MT §11 |
| Normativa firma | Ley 4.017/2010 | + Ley N° 6822/2021 (certificado cualificado de firma electrónica) | Guía de Pruebas 2026 |
| Ejemplo de CDC | 47 dígitos | 44 dígitos | MT §10.1 |
| Batería de pruebas | Resumen propio | Batería oficial completa (§15) | Guía de Pruebas 2026 |

### 0.3 Notas técnicas incorporadas

| NT | Tema | Impacto | Sección |
|---|---|---|---|
| 010 | Elimina `dSisFact` (A005); fija la URL de consulta QR | Ajuste de formato de campos y QR | §8.8 |
| 011 | Agrega el WS de consulta masiva de RUC | Fuera del MVP (candidato v1.0) | Backlog — Pendientes de priorizar |
| 012 | AFE debe emitirse en PYG (D022/1213) | Regla de validación de AFE | §8.9; HU-E7-03 |
| 014 | Agrega el evento Nominación de Factura Electrónica | Nuevo evento del emisor, en el MVP | §2.2, §8.6; HU-E8-05 |
| 015 | Exige que el documento asociado coincida con el receptor nominado (H004i/2442) | Regla cruzada con Nominación | §8.6; HU-E8-05 |
| 016 | Confirma algoritmos, canonicalización y KeyInfo de la firma; elimina el transform XPath | Resuelve D3 | §8.7 |
| 018 | Agrega el grupo `gOblAfe` (RG90) | Fuera del MVP (candidato v1.0) | Backlog — Pendientes de priorizar |
| 019 | Fija el inicio del plazo de eventos del receptor: DE desde `dFecEmi`, DTE desde la aprobación | Ajuste de plazos | §2.2, §8.6; HU-E9-01 |
| 020 | Exige tipo de operación B2G si el receptor es un Organismo o Entidad del Estado (D202b/1332) | Nueva regla de validación | §8.9; HU-E5-03 |
| 021 | Sube el umbral de receptor innominado a 35.000.000 Gs | Histórico, superado por NT 024 | §8.9 |
| 022 | Valida que `gOblAfe` no repita códigos | Fuera del MVP (candidato v1.0) | Backlog — Pendientes de priorizar |
| 023 | Agrega `dRucFus`; ajusta validaciones de receptor innominado | Fuera del MVP salvo receptor innominado | §8.9 |
| 024 | Baja el umbral de receptor innominado a 7.000.000 Gs (vigente 01/01/2025) | Reemplaza el valor anterior | §8.9; HU-E5-03 |
| 025 | Excluye GEC002c/4004: la cancelación ya no se bloquea por conformidad del receptor | Habilita la cancelación con conformidad previa | §2.2, §8.3; HU-E8-02 |
| 026 | Vuelve opcional `gCompPub` en operaciones B2G | Ajuste de la regla B2G | §8.9; HU-E5-03 |
| 027 | Ajusta los códigos de tipo de documento de identidad en Nominación | Ajuste menor de campos | §8.6; HU-E8-05 |

---

## 1. Resumen ejecutivo

Se construye una plataforma que:

1. **Expone un API HTTP** (autenticado por API Key) para que sistemas terceros soliciten la emisión de comprobantes electrónicos, se abstraigan de SIFEN y reciban webhooks con el resultado.
2. **Provee un portal web** para emisión manual, consulta de comprobantes, dashboards y administración de suscripciones.
3. **Se ejecuta end-to-end**: genera el XML del DE, lo firma con el certificado del emisor, lo envía a SIFEN (por lote o sincrónico), consulta el resultado, genera el KuDE (PDF con QR) y notifica al receptor por correo y/o WhatsApp.
4. **Es multi-tenant estricto**, con aislamiento reforzado vía **Row Level Security (RLS)** de PostgreSQL.
5. **Usa arquitectura hexagonal** en un monorepo Node.js/TypeScript: NestJS (adaptador Fastify) en el backend y Next.js en el frontend.
6. **Soporta dos modelos comerciales**: white-label/embebido (p. ej. el sistema de gestión de restaurantes) y SaaS directo con suscripción.

---

## 2. Alcance funcional

### 2.1 Documentos soportados

| Tipo | `iTiDE` | MVP (homologación) | Futuro |
|---|---|---|---|
| Factura Electrónica (FE) | 1 | ✅ | |
| Autofactura Electrónica (AFE) | 4 | ✅ | |
| Nota de Crédito Electrónica (NCE) | 5 | ✅ | |
| Nota de Débito Electrónica (NDE) | 6 | ✅ | |
| Nota de Remisión Electrónica (NRE) | 7 | ✅ | |
| Factura de Exportación / Importación | 2 / 3 | | Cuando la DNIT los habilite (MT: "Futuro"; Decreto 872/2023 art. 3) |
| Comprobante de Retención | 8 | | Ídem |

Los cinco tipos del MVP están en la batería mínima de la Guía de Pruebas. Sin ellos no se completa la homologación.

### 2.2 Eventos SIFEN

**Emisor (registro requerido):**
- **Cancelación**: hasta 48 h (FE) o 168 h (resto) desde la aprobación en SIFEN. Procede aunque el receptor ya haya dado conformidad: NT 025 (vigente 28/04/2025) excluyó la validación GEC002c/4004 que lo bloqueaba. Si el DTE tiene DTE asociados, se cancela del último al primero.
- **Inutilización**: rango de hasta 1000 números, sin ningún número aprobado en el rango. Plazo: dentro de los 15 primeros días del mes siguiente, y hasta el fin de validez del timbrado. Motivo obligatorio (5–500 caracteres).
- **Nominación de Factura Electrónica**: nombra al comprador de una FE emitida a receptor innominado (D208=5). NT 014, ajustada por NT 015 y NT 027. Ver §8.6.
- Actualización de datos del transporte (NRE): opcional, fuera del MVP.

**Receptor (registro requerido)**, para clientes que también reciben DTE:
- Notificación de recepción, Conformidad (parcial/total), Disconformidad, Desconocimiento: hasta 45 días — desde `dFecEmi` si el documento es DE, desde la fecha de aprobación si es DTE (NT 019).
- Corrección de evento del receptor: hasta 15 días desde el primer evento; una sola corrección por evento.
- Respetar la matriz de compatibilidad entre eventos (MT §11, tabla de relaciones).

**Automáticos de SIFEN** (no los emite la plataforma, se leen al consultar el DTE): Devolución y Ajuste de precios (al aprobar NC/ND), Asociación, anticipo, remisión, retención, créditos fiscales.

**Transmisión:** `siRecepEvento` acepta **hasta 15 eventos por envío**, cada uno firmado.

### 2.3 Servicios Web SIFEN

| Servicio | WSDL (`{amb}` = `sifen.set.gov.py` o `sifen-test.set.gov.py`) | Límite / regla |
|---|---|---|
| `siRecepDE` (sincrónico) | `https://{amb}/de/ws/sync/recibe.wsdl` | Mensaje ≤ 1000 KB (0200). Requiere RUC habilitado para servicio síncrono (1264) |
| `siRecepLoteDE` | `https://{amb}/de/ws/async/recibe-lote.wsdl` | ≤ 50 DE, un RUC, un tipo, zip + Base64, **≤ 1000 KB** (Guía 2024; el MT dice 10.000 KB, se toma el más restrictivo) |
| `siResultLoteDE` (consulta-lote) | `https://{amb}/de/ws/consultas/consulta-lote.wsdl` | Primera consulta ≥ 10 min; luego cada ≥ 10 min; válida hasta 48 h (0364) |
| `siConsDE` | `https://{amb}/de/ws/consultas/consulta.wsdl` | 0420 = no existe o rechazado; 0422 = aprobado (devuelve XML) |
| `siRecepEvento` | `https://{amb}/de/ws/eventos/evento.wsdl` | ≤ 15 eventos por envío |
| `siConsRUC` | `https://{amb}/de/ws/consultas/consulta-ruc.wsdl` | RUC sin DV; con caché |

Todos usan SOAP 1.2 Document/Literal sobre TLS 1.2 con autenticación mutua. Cada llamada lleva un `dId` numérico (1–15 dígitos), secuencial y generado por el emisor.

### 2.4 Notificaciones

- **Email** al receptor con XML + KuDE PDF, remitente parametrizable por tenant.
- **WhatsApp** (Meta Cloud API) con link corto al KuDE.
- **Webhooks** al sistema que solicitó la emisión.

Canales parametrizables por request (`notificaciones.canales`) con política por defecto del tenant.

> El XML que recibe el receptor puede incluir `dInfAdic` (J003). El XML enviado a SIFEN **no** puede incluirlo (2503). Se generan y almacenan ambas versiones.

---

## 3. Arquitectura de alto nivel

```
          Cliente externo (ERP / POS / sistema de gestión)
                         │ HTTPS + API Key + Idempotency-Key
                         ▼
               API Gateway / Ingress (rate limit, tenant resolver)
                  │                                 │
        Portal Web (Next.js, BFF)            REST API (NestJS + Fastify)
                  └──────────────┬──────────────────┘
                                 ▼
                   Núcleo de dominio (hexagonal)
            Emisión, numeración, firma, eventos, KuDE, billing
                 │              │               │
           PostgreSQL        Redis          Object Storage
           (RLS + audit)   (BullMQ/cache)   (XML, PDF, certs cifrados)
                 │
                 ▼
         Workers (proceso NestJS separado, mismo código)
          · LoteBuilderWorker        (arma y envía lotes)
          · LoteResultPollWorker     (consulta-lote / consulta por CDC)
          · SyncSubmitWorker         (solo si el RUC tiene sincrónico)
          · EventBatchWorker         (lotes de hasta 15 eventos)
          · DeadlineWatchWorker      (72 h de transmisión, plazos de eventos)
          · KudePdfWorker
          · NotificationDispatchWorker / WebhookDeliveryWorker
          · RucCacheRefreshWorker
                 │
          SIFEN WS (mTLS)   Email (SES)   WhatsApp Cloud API
```

---

## 4. Decisiones tecnológicas

| Área | Elección | Justificación |
|---|---|---|
| Runtime | Node.js 22 LTS + TypeScript | Ecosistema TIPS S.A. para SIFEN (no es obligatorio: el MT admite cualquier lenguaje) |
| Backend | NestJS con adaptador **Fastify** | DI, módulos, guards, interceptors, OpenAPI; afín a Spring |
| Frontend | Next.js 15 + Tailwind + shadcn/ui | SSR/BFF del portal |
| Monorepo | Turborepo + pnpm | Tipos y contratos compartidos |
| Acceso a datos | Drizzle ORM (o Kysely) | Transacciones tipadas + `SET LOCAL` para RLS |
| Contexto de tenant | `nestjs-cls` (AsyncLocalStorage) | Sin providers REQUEST-scoped; mismo mecanismo en API y workers |
| Base de datos | PostgreSQL 16 | RLS, particionamiento, JSONB |
| Colas | Redis 7 + BullMQ (`@nestjs/bullmq`) | Reintentos, delays, DLQ |
| Object storage | S3 / MinIO | XML, KuDE, certificados cifrados |
| Generación XML | `facturacionelectronicapy-xmlgen` (TIPS, MIT, MT 150) | CDC, DV, validación de entrada, eventos |
| Firma | **Evaluar** `facturacionelectronicapy-xmlsign`; alternativa `xml-crypto` | XMLDSig enveloped (sin XAdES) |
| QR | **Evaluar** `facturacionelectronicapy-qrgen`; alternativa propia | Hash SHA-256 con CSC |
| Cliente SIFEN | **Evaluar** `facturacionelectronicapy-setapi`; alternativa cliente SOAP propio | SOAP 1.2 + mTLS |
| KuDE | Propio (React-PDF o Puppeteer); `facturacionelectronicapy-kude` como referencia | Branding por tenant |
| Validación XSD | XSD oficiales v150 + Prevalidador en CI | Rechazos tempranos, evita bloqueos de RUC |
| mTLS | `https.Agent` con PFX cargado desde KMS | EKU `clientAuth` requerido |
| Cifrado de certificados | KMS / Vault Transit (envelope encryption) | Nunca `.p12` en claro |
| Email / WhatsApp | SES + MJML / Meta Cloud API | |
| Pagos SaaS | Bancard vPOS / Pagopar (+ Stripe exterior) | |
| Auth humana | Better Auth o Keycloak | MFA, SSO |
| Observabilidad | OpenTelemetry → Grafana; Sentry | Traza DE → SIFEN → notificación |
| CI/CD, IaC | GitHub Actions, Docker, Terraform | |

Todas las librerías de TIPS se envuelven detrás de puertos. Si alguna no cumple, se reemplaza el adaptador sin tocar el dominio.

---

## 5. Arquitectura hexagonal

Cada bounded context es un módulo NestJS. **`domain/` y `application/` son TypeScript puro**: sin decorators de Nest. Se ensamblan en el módulo con `useFactory`, y una regla de `dependency-cruiser` prohíbe importar `@nestjs/*` en esas carpetas.

```
src/modules/emision/
├── domain/
│   ├── entities/        documento-electronico, lote, evento
│   ├── value-objects/   cdc, ruc, timbrado, numeracion, serie, codigo-seguridad
│   ├── services/        cdc-generator, plazos-sifen, lote-builder
│   ├── events/          documento-firmado, documento-aprobado, documento-rechazado
│   └── ports/           sifen.gateway, de-xml-builder, xml-signer,
│                        certificate-store, documento.repository, kude-renderer, qr-generator
├── application/
│   ├── commands/        emitir-de, corregir-y-reenviar, cancelar, inutilizar-rango
│   ├── queries/
│   └── handlers/
└── infrastructure/
    ├── adapters/        sifen (setapi o SOAP propio), xmlgen, signing, qr, kude, kms, persistence
    ├── controllers/     REST pública, BFF portal
    └── workers/         processors BullMQ (heredan TenantAwareProcessor)
```

### 5.1 Puertos principales

```typescript
export interface SifenGateway {
  enviarLote(xmlsFirmados: string[], dId: bigint): Promise<SifenLoteReceipt>;       // 0300 / 0301
  consultarLote(nroLote: string, dId: bigint): Promise<SifenLoteResult>;            // 0360 / 0361 / 0362 / 0364
  enviarDESincronico(xmlFirmado: string, dId: bigint): Promise<SifenProtocoloDE>;   // solo si el RUC está habilitado
  consultarDE(cdc: Cdc, dId: bigint): Promise<SifenConsDE>;                         // 0420 / 0422
  enviarEventos(eventosFirmados: string[], dId: bigint): Promise<SifenEventosResult>; // ≤ 15
  consultarRUC(ruc: string, dId: bigint): Promise<SifenConsRUC>;
}

export interface DeXmlBuilder {
  buildParaSifen(de: DocumentoElectronico): Promise<string>;    // sin dInfAdic (J003)
  buildParaReceptor(de: DocumentoElectronico): Promise<string>; // puede incluir dInfAdic
}

export interface XmlSigner { sign(xml: string, cert: LoadedCertificate): Promise<string>; }
export interface QrGenerator { buildUrl(xmlFirmado: string, csc: Csc, ambiente: Ambiente): string; }
```

---

## 6. Bounded Contexts

| BC | Responsabilidad |
|---|---|
| Identity & Access | Tenants, usuarios, API keys, roles |
| Tenant Configuration | RUC, actividades, establecimientos, puntos de expedición, timbrados, CSC (hasta 2 activos), ambiente, branding |
| Certificate Management | Alta, custodia en KMS, validación (RUC, EKU, vigencia), alertas de vencimiento |
| Numeración | `dNumDoc`, serie, `dCodSeg`, `dId`, inutilizaciones |
| Emisión (core) | Ciclo de vida del DE, lotes, sincrónico, rechazos y correcciones |
| Eventos | Cancelación, inutilización, eventos de receptor, lotes de hasta 15 |
| KuDE | PDF formato carta y cinta, QR |
| Notifications | Email, WhatsApp, webhooks |
| Billing (SaaS) | Planes, suscripciones, cuotas, pagos |
| Audit | Log append-only con hash chain |
| Ops | Panel interno, reprocesos manuales |

---

## 7. Modelo de datos multi-tenant con RLS

### 7.1 Estrategia (sin cambios)

- Base y schema compartidos; `tenant_id UUID NOT NULL` en toda tabla operativa.
- `ENABLE` + `FORCE ROW LEVEL SECURITY`; el rol de la app no tiene `BYPASSRLS`.
- `SET LOCAL app.current_tenant` al abrir **cada** transacción, desde un único punto (plugin transaccional de CLS). Los workers abren el mismo contexto con el `tenant_id` del payload del job.

### 7.2 Tabla de documentos (corregida)

```sql
CREATE TABLE documentos_electronicos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  ambiente VARCHAR(10) NOT NULL,                 -- test | prod
  cdc CHAR(44) NOT NULL,
  tipo_documento SMALLINT NOT NULL,              -- iTiDE
  numero_timbrado CHAR(8) NOT NULL,
  establecimiento CHAR(3) NOT NULL,
  punto_expedicion CHAR(3) NOT NULL,
  numero_documento CHAR(7) NOT NULL,
  serie CHAR(2),                                 -- solo tras agotar 9999999
  codigo_seguridad CHAR(9) NOT NULL,             -- dCodSeg aleatorio
  estado VARCHAR(32) NOT NULL,                   -- ver §8.0
  ruc_emisor VARCHAR(15) NOT NULL,
  ruc_receptor VARCHAR(15),
  fecha_emision TIMESTAMP NOT NULL,              -- hora local PY, sin zona (MT)
  fecha_firma TIMESTAMP NOT NULL,                -- inicia el plazo de 72 h
  fecha_aprobacion_sifen TIMESTAMP,              -- inicia plazos de cancelación
  numero_transaccion_sifen VARCHAR(10),          -- dProtAut
  monto_total NUMERIC(23,8) NOT NULL,
  moneda CHAR(3) NOT NULL,
  payload_original JSONB NOT NULL,
  xml_sifen_url TEXT,                            -- sin dInfAdic
  xml_receptor_url TEXT,                         -- con dInfAdic si aplica
  kude_pdf_url TEXT,
  ultimo_lote_id UUID,
  intentos_envio SMALLINT NOT NULL DEFAULT 0,
  respuesta_sifen JSONB,
  idempotency_key VARCHAR(120),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, ambiente, cdc),
  UNIQUE (tenant_id, idempotency_key)
);
```

Las fechas SIFEN no llevan zona horaria (MT §7.2.3). Se guardan en hora local de Paraguay y, en paralelo, en `timestamptz` para operación interna.

### 7.3 Tablas nuevas o modificadas

- `secuencia_did (tenant_id, ambiente, ultimo_valor BIGINT)`: generador de `dId` por tenant.
- `numeracion_secuencial (tenant_id, ambiente, timbrado, est, pto_exp, tipo_doc, serie, ultimo_numero)`: incluye la serie activa.
- `series_timbrado (tenant_id, timbrado, est, pto_exp, tipo_doc, serie, fecha_inicio)`: registra desde cuándo rige cada serie.
- `lotes_sifen (id, tenant_id, ambiente, tipo_documento, d_id, numero_lote_sifen, estado, enviado_at, proxima_consulta_at, vence_consulta_at)`: `vence_consulta_at` = envío + 48 h.
- `eventos_sifen (id, tenant_id, tipo, documento_id NULL, rango JSONB NULL, lote_eventos_id, estado, respuesta_sifen, firmado_at)`.
- `csc_codes`: hasta 2 activos por tenant y ambiente.
- `bloqueos_ruc (tenant_id, ambiente, desde, hasta, motivo)`: pausa de envíos por bloqueo.
- El resto de tablas de la v1.0 se mantiene (identity, branding, notificaciones, webhooks, billing, audit).

---

## 8. Flujos principales

### 8.0 Máquina de estados del DE

```
draft → signed → queued → submitted ──┬─→ approved
                                      ├─→ approved_with_observations   (p. ej. extemporáneo, 1005)
                                      └─→ rejected ──┬─→ corrected → signed (mismo CDC)
                                                     └─→ number_voided (inutilizado) → nuevo DE
approved | approved_with_observations → cancelled
```

- `approved`, `approved_with_observations` y `rejected` se derivan de **`dEstRes`** (Aprobado / Aprobado con observación / Rechazado), no del código.
- Un DE rechazado se corrige y reenvía **con el mismo CDC** si la corrección no altera los campos que componen el CDC (tipo, RUC y DV del emisor, establecimiento, punto, número, tipo de contribuyente, fecha de emisión, tipo de emisión, código de seguridad). Si los altera, el número se **inutiliza** y se emite un DE nuevo (MT §6.5).

### 8.1 Emisión (camino principal: lote asincrónico)

```
1. POST /v1/documents (API Key + Idempotency-Key)
2. Resolver tenant → contexto CLS → SET LOCAL
3. Validar payload (Zod) y reglas de dominio (§8.9)
4. Handler EmitirDE:
   a. Idempotencia
   b. Número (FOR UPDATE / INSERT … ON CONFLICT) + dCodSeg aleatorio
   c. xmlgen → XML (versión SIFEN y versión receptor)
   d. Validar contra XSD oficial v150
   e. Firmar (§8.7); guardar fecha_firma → arranca el reloj de 72 h
   f. Generar QR con CSC → dCarQR
   g. Persistir en estado "signed" y encolar en el LoteBuilder del (tenant, tipo)
5. Responder 202 con document_id y CDC
6. KuDE: puede generarse y entregarse ya (modelo de validación posterior, MT §6.2)
```

**LoteBuilder (invariantes de dominio):**
- Un solo RUC emisor y un solo tipo de DE por lote.
- ≤ 50 DE; flush por cantidad o por intervalo.
- Mensaje (zip + Base64 + envelope) ≤ 1000 KB.
- Nunca incluir un CDC que esté en otro lote todavía en procesamiento.
- Nunca repetir un CDC dentro del mismo lote ni reenviar el mismo lote.

**Envío y consulta:**
1. `siRecepLoteDE` → 0300 (guardar `dProtConsLote`) o 0301 (no encolado: revisar motivo; si es bloqueo, ver §8.5).
2. Si no hay respuesta (timeout o corte de red): **no reenviar**. Consultar el lote usando un CDC enviado en él para recuperar el estado y el número de lote.
3. `LoteResultPollWorker`: primera consulta a los 10 min, luego cada ≥ 10 min. En picos puede tardar de 1 a 24 h.
   - 0361 → seguir consultando.
   - 0362 → procesar `gResProcLote` DE por DE (`dEstRes`).
   - 0364 (pasadas 48 h) o 0360 → consultar cada CDC con `siConsDE` (0422 aprobado; 0420 no existe o rechazado).
4. Por cada DE: publicar `DocumentoAprobado` / `DocumentoRechazado` → notificaciones y webhooks.

### 8.2 Emisión sincrónica (opcional)

Solo para tenants cuyo RUC está habilitado para el servicio síncrono (si no, SIFEN responde 1264). Se usa para casos que necesitan respuesta inmediata (`?wait=true`, timeout 30 s). Se aplican las mismas reglas de estado y de no reenvío.

### 8.3 Cancelación

```
POST /v1/documents/{cdc}/cancel { motivo (5–500) }
→ Validar estado aprobado y plazo: FE ≤ 48 h, resto ≤ 168 h desde fecha_aprobacion_sifen
→ Si tiene DTE asociados: exigir cancelar primero los asociados (del último al primero)
→ Generar y firmar evento → EventBatchWorker (≤ 15 por envío)
```

### 8.4 Inutilización

```
POST /v1/numbering/inutilize { timbrado, est, pto, tipo, desde, hasta, motivo }
→ hasta − desde ≤ 1000; hasta > desde
→ Ningún número del rango aprobado ni ya inutilizado
→ Alerta si se acerca el día 15 del mes siguiente al salto de numeración
```

La inutilización también se dispara automáticamente desde el flujo de rechazo cuando la corrección altera el CDC.

### 8.5 Indisponibilidad de SIFEN y bloqueos (reemplaza "Contingencia")

- **No se usa `iTipEmi = 2`**: la contingencia está indefinida en MT v150 y SIFEN la rechaza (1050). Se revisa si alguna nota técnica posterior la habilitó.
- **SIFEN caído**: los DE quedan firmados y en cola. El KuDE se entrega igual (validación posterior). Se reintenta con backoff y un circuit breaker por endpoint.
- **Límite de 72 h desde `fecha_firma`**: `DeadlineWatchWorker` alerta al tenant a las 48 h y a las 66 h sin aprobación. Pasadas 72 h, la aprobación llega con observación por extemporaneidad (1005).
- **Ventana de fecha de emisión**: hasta 30 días atrasada y hasta 5 días adelantada respecto de la transmisión (1150/1151).
- **Bloqueo por RUC (10–60 min, Guía 2024)**: lo provocan lotes vacíos o inválidos, CDC repetido en un lote, CDC repetido en lotes en procesamiento o el mismo lote reenviado. Ante un 0301 por bloqueo se pausa ese tenant y se reencola con delay. La mejor defensa son las invariantes del LoteBuilder y la validación XSD previa.

### 8.6 Eventos de receptor y nominación de FE

Para tenants que también reciben DTE: notificación de recepción, conformidad (parcial → total), disconformidad, desconocimiento y corrección. Se validan plazos (45 días — desde `dFecEmi` si es DE, desde la fecha de aprobación si es DTE, NT 019 — y 15 días para corregir) y la matriz de compatibilidad antes de enviar.

**Nominación de Factura Electrónica (evento del emisor):** nombra al comprador de una FE emitida a receptor innominado (D208=5). Campos `GENFE0xx` (NT 014, ajustada por NT 015 y NT 027). Un solo evento por CDC (4453); el CDC debe corresponder a una FE del propio emisor (4454/4468) y el receptor de esa FE debe ser innominado (4469). Si después se asocia una NCE/NDE a esa FE, el receptor del documento asociado debe coincidir con el nominado (H004i/2442, NT 015).

### 8.7 Firma digital

```
LoadedCertificate ← CertificateStore.loadForTenant(tenantId)
  └─ KMS descifra la data key → .p12 descifrado en memoria (nunca a disco ni a logs)

XmlSigner (XMLDSig enveloped):
  ├─ Firma el nodo <DE> (grupo A001); Reference URI = "#" + CDC
  ├─ Transform: único, enveloped-signature (NT 016 elimina el transform XPath)
  ├─ CanonicalizationMethod: c14n inclusiva o exclusiva, con o sin comentarios, son válidas (NT 016);
  │    se usa exc-c14n (así lo usa el ejemplo oficial xml_DE)
  ├─ DigestMethod SHA-256/384/512; SignatureMethod RSA-SHA-256/384/512 (NT 016);
  │    se usa SHA-256 / RSA-SHA256 (RSA 2048, o 4096 por hardware)
  ├─ <Signature xmlns="http://www.w3.org/2000/09/xmldsig#"> dentro de <rDE>, después de <DE>
  └─ KeyInfo: solo <X509Data><X509Certificate> (NT 016 confirma que no se acepta X509IssuerSerial,
       X509SubjectName ni KeyValue; resuelve D3)
```

**Reglas de formato del XML (MT §7.2.4):** sin espacios ni saltos de línea entre etiquetas, sin prefijos de namespace, sin etiquetas vacías (salvo las obligatorias), sin negativos, nombres sensibles a mayúsculas. `<gCamFuFD><dCarQR>` va después de `<Signature>`, con `&` escapado como `&amp;`.

**Certificado:**
- Emitido por un PSC/PCSC habilitado por el MIC.
- RUC en `SerialNumber` (persona jurídica) o `SubjectAlternativeName` (persona física), con formato `RUCXXXXXXXX-X`.
- EKU `clientAuth` para mTLS.
- Vigente y no revocado al momento de la firma (2450).
- El RUC del certificado debe coincidir con `dRucEm`.

### 8.8 QR

URL de consulta (NT 010): producción `https://ekuatia.set.gov.py/consultas/qr?`, test `https://ekuatia.set.gov.py/consultas-test/qr?`. Se completa con `nVersion, Id, dFeEmiDE (hex), dRucRec | dNumIDRec, dTotGralOpe, dTotIVA, cItems, DigestValue (hex), IdCSC` + `cHashQR` = SHA-256 hex de los parámetros concatenados con el CSC. El CSC nunca viaja en la URL. Hasta 2 CSC activos por tenant.

### 8.9 Reglas de dominio a validar antes de enviar

- `dCodSeg`: 9 dígitos, aleatorio (CSPRNG), distinto por DE y distinto de `dNumDoc`.
- `dNumDoc` empieza en 1 por timbrado. La serie se usa **solo** al agotar 9999999, en orden AA…ZZ sin Ñ, respetando la secuencialidad y la fecha de inicio de cada serie (1110).
- NCE: la suma de los totales de las NC no puede superar el total de la FE (2417). NC/ND en la misma moneda que la FE (2438).
- Receptor innominado prohibido cuando el total ≥ 7.000.000 Gs (D208c/1321, NT 024, vigente 01/01/2025; historial: MT 60.000.000 → NT 021 35.000.000 → NT 024 7.000.000). El umbral debe ser configurable (ADR-0012), no hardcodeado.
- Si el RUC del receptor corresponde a un Organismo o Entidad del Estado (OEE), el tipo de operación debe ser B2G (D202b/1332, NT 020); `gCompPub` es opcional en ese caso (NT 026).
- Redondeo a múltiplos de 50 Gs (moneda extranjera: 50 céntimos).
- AFE: receptor = emisor, B2C, contado, moneda PYG (D022/1213, NT 012), documento asociado = constancia electrónica.
- NRE: sin totales ni valores por ítem; transporte, salida, entrega, vehículo y transportista obligatorios.
- Validaciones cruzadas departamento/distrito/ciudad y descripción = código (tablas oficiales).
- Ambiente de test: literales obligatorios (ver §15.2).

---

## 9. Seguridad

Sin cambios de fondo respecto de la v1.0: API keys con Argon2id y scopes, certificados con envelope encryption, CSC cifrado, RLS con defensa en profundidad, webhooks firmados con HMAC y protección contra replay, auditoría con hash chain, HTTPS/HSTS, CSP y secretos en Vault.

Además:
- Validar el certificado al darlo de alta: RUC en el campo correcto, EKU `clientAuth`, vigencia y cadena.
- Bloqueo preventivo de la emisión el día previo al vencimiento del certificado.

---

## 10. Notificaciones

Sin cambios respecto de la v1.0 (contrato, plantillas MJML y WhatsApp, reintentos con backoff, white-label). Única diferencia: se adjunta el **XML del receptor** (no el enviado a SIFEN).

---

## 11. Suscripciones (SaaS)

Sin cambios respecto de la v1.0. El dogfooding (el SaaS se factura a sí mismo con la plataforma) queda para después de producción.

---

## 12. Escalabilidad y resiliencia

- API y workers stateless; colas separadas: `lote-build`, `lote-poll`, `sync-submit`, `event-batch`, `deadline-watch`, `kude-render`, `notification-*`, `webhook-delivery`.
- Rate limit por tenant hacia SIFEN y pausa por bloqueo de RUC.
- Circuit breaker por endpoint SIFEN.
- Particionamiento mensual de `documentos_electronicos`; réplica de lectura para reportes.
- Retención de XML y KuDE según el plazo tributario vigente (confirmar con un contador o asesor; el MT menciona 5 años para DTE cancelados o ajustados).

---

## 13. Observabilidad

Métricas adicionales a las de la v1.0:
- `sifen_lote_processing_seconds` (envío → 0362)
- `sifen_lote_status_total{codigo}` (0300, 0301, 0361, 0362, 0364)
- `sifen_ruc_blocks_total`
- `de_pending_transmission{bucket="<24h|24-48h|48-72h|>72h"}`
- `sifen_rejections_total{codigo}`

Alertas: DE a menos de 6 h de cumplir 72 h, bloqueo de RUC, tasa de rechazo > 5 %, certificado por vencer.

---

## 14. Portal web

Sin cambios respecto de la v1.0, más:
- Pantalla de **DE pendientes de transmisión** con el reloj de 72 h.
- **Rechazos**: motivo SIFEN, botón "corregir y reenviar" (mismo CDC) o "inutilizar y reemitir".
- **Eventos de receptor** sobre DTE recibidos.

---

## 15. Testing y homologación

### 15.1 Estrategia técnica

- Unit (Vitest) en `domain/` y `application/` (≥ 85 %).
- Integración con Testcontainers (Postgres, Redis, MinIO).
- **Validación XSD** de todo XML generado contra los XSD oficiales v150, más el **Prevalidador SIFEN** para fixtures representativos.
- Mock SOAP local con los códigos reales (0300/0301, 0360/0361/0362/0364, 0420/0422, 0600, rechazos).
- Tests de aislamiento multi-tenant (app y base de datos).
- Tests de invariantes del LoteBuilder (evitan bloqueos de RUC).
- E2E con Playwright; carga con k6; caos (SIFEN caído, Redis caído, latencia de KMS).

### 15.2 Datos del ambiente de pruebas (Guía de Pruebas, feb/2026)

| Dato | Valor |
|---|---|
| Timbrado | RUC del contribuyente (sin DV), con un "0" inicial de corresponder; fechas, establecimiento y hasta 3 puntos de expedición se generan en el SGTM |
| Emisor | Datos reales según Marangatu |
| Razón social del emisor | "DOCUMENTO ELECTRÓNICO SIN VALOR COMERCIAL NI FISCAL - GENERADO EN AMBIENTE DE PRUEBA" |
| Primer ítem | Descripción con el mismo literal |
| Receptor | Datos reales de clientes |
| CSC | IdCSC 0001 `ABCD0000000000000000000000000000`; IdCSC 0002 `EFGH0000000000000000000000000000` |

> ⚠️ **Resuelto en papel (D2):** el MT v150 (D105, validación 1263) y el ejemplo oficial xml_DE exigen el literal "DE generado en ambiente de prueba - sin valor comercial ni fiscal"; la Guía de Pruebas 2026 §2 pide el de la tabla anterior. Por orden de precedencia (§0.1) rige el de la Guía. Se parametriza por ambiente y queda pendiente confirmarlo con el Prevalidador antes de la homologación.

### 15.3 Batería mínima de pruebas (Guía de Pruebas 2026)

> La Guía la presenta como pruebas mínimas **sugeridas**, no como una homologación que la DNIT aprueba formalmente. Si se exige evidencia para habilitar producción, está pendiente de confirmar (PRD, D1).

| Escenario | Cantidad |
|---|---|
| Comunicación y mTLS con certificado válido | 1 por WS (sync, async, consulta-lote, consulta DE, evento, consulta RUC) |
| Comunicación con certificado **no válido** | Recomendado, por WS |
| Sincrónico aprobados | 5 por tipo (FE con ≥ 2 ítems, NCE, NDE, AFE, NRE), 1 DE por conexión |
| Sincrónico rechazados (errores distintos) | 5 por tipo |
| Asincrónico aprobados | 5 por tipo en 1 lote (se recomiendan 30–50 por lote) |
| Asincrónico rechazados | 5 por tipo en 1 lote (se recomiendan 3–5) |
| Cancelación | 5 (cualquier DE) |
| Inutilización | 2 de FE, 1 de NCE, 1 de NDE, 1 de AFE |
| Eventos de receptor | 3 conformidad, 3 disconformidad, 3 desconocimiento, 3 notificación de recepción, 3 ajuste de evento (corrección de un evento previo, HU-E9-02; distinto del evento automático "Devolución y Ajuste" de §0.2, que no se emite) |
| Consulta de DTE por CDC | 3 por tipo |
| KuDE en PDF | 1 por tipo |
| Consulta de DTE por QR | 2 por tipo |

Si el RUC no queda habilitado para el servicio síncrono, se consulta con la DNIT cómo cubrir esos escenarios.

---

## 16. Roadmap por fases (ajustado)

> **Reemplazada por [`docs/roadmap.md`](../roadmap.md)**, que define el MVP, la v1.0 estable y la v1.1 con gates de salida. Esta sección se conserva como referencia.

### Fase 0 — Preparación y PoC (2–3 semanas)
- Monorepo, CI/CD, infraestructura base, plantilla de módulo hexagonal y regla de dependencias.
- Habilitación como facturador electrónico en test (SGTM), certificado y CSC.
- **Revisar las notas técnicas vigentes** y resolver: contingencia, literal de test, tamaño de lote (canonicalización y `KeyInfo`/`X509IssuerSerial` ya resueltos por NT 016).
- PoC con TIPS (xmlgen + xmlsign + qrgen + setapi): 1 FE aprobada por lote y 1 por sincrónico contra `sifen-test`. Decidir qué librerías quedan y cuáles se reemplazan.

### Fase 1 — MVP homologable (8–10 semanas)
- Identity, Tenant Config, Certificados, Numeración (serie, `dCodSeg`, `dId`).
- **FE, NCE, NDE, AFE y NRE**.
- Lote asincrónico completo (LoteBuilder, consulta, recuperación, 0364) y sincrónico opcional.
- Rechazos: corregir y reenviar, o inutilizar.
- Eventos de emisor (cancelación, inutilización, nominación de FE) y de receptor (4 tipos + corrección).
- KuDE (carta y cinta) + QR.
- Notificación por email y webhooks básicos.
- Portal mínimo: login, emisión, listado, detalle, pendientes y rechazos.
- Auditoría base.
- **Batería de homologación completa (§15.3).**

**Salida:** batería mínima completada (con evidencia archivada) y alta en producción con un cliente piloto (el sistema de restaurantes).

### Fase 2 — Producción y SaaS (6 semanas)
- Pilotos en producción (3–5 clientes).
- WhatsApp, dashboards, cuotas por plan, billing con Bancard/Pagopar, panel de operaciones.
- Hardening: alertas de 72 h, bloqueos, métricas SIFEN.

### Fase 3 — White-label y escala (4–6 semanas)
- CNAME y branding por tenant, plantillas de KuDE, SSO, reportes fiscales, integraciones.

### Fase 4 — Continuo
- FEE, FEI y Comprobante de Retención cuando la DNIT los habilite.
- Evento de actualización de datos del transporte.
- App móvil.

> Las duraciones suponen el equipo de la §17. Con un equipo más chico, la Fase 1 debe estirarse o recortarse; la batería de homologación no se puede recortar.

---

## 17. Equipo estimado

Sin cambios respecto de la v1.0 (unas 8–9 personas). **Supuesto a validar** con el equipo real disponible.

---

## 18. Riesgos y mitigaciones (actualizado)

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Notas técnicas posteriores a v150 cambian reglas | Alto | Revisión en Fase 0; adaptadores aislados; suscripción a novedades de la DNIT |
| Documentación oficial contradictoria (literal de test, tamaño de lote) | Medio | Prevalidador en CI; consulta formal a la mesa de ayuda de la DNIT |
| RUC sin habilitación para sincrónico | Medio | Lote como camino principal |
| Bloqueo de RUC por errores de envío | Medio | Invariantes del LoteBuilder, validación XSD previa, pausa automática |
| Lotes que tardan hasta 24 h | Medio | KuDE inmediato (validación posterior); estados visibles; webhooks al aprobar |
| Superar 72 h sin aprobación | Medio | DeadlineWatchWorker con alertas escalonadas |
| Rechazo que obliga a cambiar el CDC | Medio | Flujo automático de inutilización y reemisión |
| Dependencia de librerías de TIPS (comunidad) | Medio | Detrás de puertos; fork y tests de contrato |
| Vencimiento de certificado | Alto | Alertas a 60/30/7 días y bloqueo preventivo |
| Fuga de clave privada | Crítico | KMS, memoria, auditoría de accesos |
| Vulneración de RLS | Crítico | `FORCE RLS`, rol sin BYPASSRLS, tests de aislamiento, contexto CLS también en workers |

---

## 19. Contratos de API (cambios)

Se agregan o modifican respecto de la v1.0:

```
POST   /v1/documents/{id}/correct       Corregir un rechazado (mismo CDC si aplica; si no, inutiliza y reemite)
GET    /v1/documents?estado=pending_transmission
POST   /v1/received-documents/{cdc}/events   Eventos de receptor
```

Eventos webhook adicionales: `document.approved_with_observations` (reemplaza `approved_with_warnings`), `document.number_voided`, `document.transmission_deadline_warning`.

Ejemplo de payload (CDC de 44 dígitos):

```json
{
  "id": "evt_01HZ...",
  "type": "document.approved",
  "created_at": "2026-09-22T14:30:00-03:00",
  "tenant_id": "tnt_...",
  "data": {
    "document_id": "doc_...",
    "cdc": "01028052080001001000013622023100111644108186",
    "tipo": "factura_electronica",
    "numero": "001-001-0001362",
    "estado": "approved",
    "numero_transaccion_sifen": "0000000000",
    "fecha_aprobacion_sifen": "2026-09-22T14:29:57",
    "urls": { "xml": "https://.../xml", "kude": "https://.../kude.pdf" }
  }
}
```

---

## 20. Consideraciones legales y de compliance

- Ley 125/1991 (régimen tributario) y Decreto 7.795/2017 (creación del SIFEN).
- Decreto 872/2023 (citado por la Guía de Pruebas para incorporar otros DE).
- Ley 4.017/2010 (citada por el MT) y **Ley 6822/2021** (certificado cualificado de firma electrónica, citada por la Guía 2026).
- Resoluciones vigentes de la DNIT (ex SET).
- Protección de datos personales: **confirmar con asesor legal** la norma vigente aplicable a los datos de receptores.
- Plazo de conservación de DTE: confirmar con asesor contable.
- KuDE conforme al MT §13 (encabezado, ítems, totales, consulta, QR de al menos 25 mm).

---

## 21. Próximos pasos inmediatos

1. **Semana 1:** habilitación en test (SGTM), certificado, CSC. Descargar y revisar las **notas técnicas vigentes**.
2. **Semana 1:** consulta a la mesa de ayuda de la DNIT sobre las contradicciones de §18.
3. **Semana 1–2:** PoC con TIPS, 1 FE por lote y 1 por sincrónico en `sifen-test`, validadas con el Prevalidador.
4. **Semana 2–3:** decidir qué librerías quedan, esqueleto del monorepo, IaC inicial.
5. **Semana 3:** kickoff de la Fase 1 con backlog que cubra la batería completa de homologación.

---

*Fin del documento.*
