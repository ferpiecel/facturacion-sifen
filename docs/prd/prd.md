# PRD — Plataforma de Facturación Electrónica SIFEN

| | |
|---|---|
| **Estado** | Vigente para el MVP (v0.1) |
| **Dueño de producto** | Fer |
| **Diseño técnico** | [`docs/plan/plan-desarrollo-v1.1.md`](../plan/plan-desarrollo-v1.1.md) |
| **Roadmap** | [`docs/roadmap.md`](../roadmap.md) |
| **Decisiones** | [`docs/adr/`](../adr/) |

Este documento define **qué** se construye y **para quién**. El **cómo** está en el plan técnico y no se repite aquí.

---

## 1. Problema

En Paraguay, los contribuyentes designados (y los voluntarios) deben emitir sus comprobantes como documentos electrónicos ante el SIFEN de la DNIT. Integrarse directamente con SIFEN implica:
- generar XML según un manual técnico extenso;
- firmar con certificado cualificado;
- usar SOAP con autenticación mutua;
- manejar lotes asincrónicos que tardan de minutos a horas;
- respetar plazos (72 h, 48/168 h, día 15);
- generar el KuDE.

Para un sistema de gestión (ERP, POS, software de restaurantes) resolver todo esto por su cuenta es caro, y para una PyME sin sistema es inviable.

## 2. Objetivos

| # | Objetivo | Cómo se mide |
|---|---|---|
| O1 | Un sistema de gestión emite un comprobante electrónico con **una llamada HTTP**, sin conocer SIFEN | Integración del piloto en menos de 5 días de desarrollo del integrador |
| O2 | El usuario final del sistema integrado **no percibe** la plataforma (modo embebido) | Ninguna pantalla, correo ni KuDE muestra la marca de la plataforma si el tenant no lo desea |
| O3 | Una PyME o profesional factura desde el portal con una **suscripción mensual** | Alta y primera FE aprobada en producción en menos de 1 día hábil, una vez que tiene su certificado |
| O4 | **Aislamiento total** entre clientes | 0 accesos cruzados; test de aislamiento obligatorio en cada release |
| O5 | Ningún comprobante se pierde ni se duplica ante SIFEN | 0 CDC duplicados; 100 % de los DE con resultado final o alerta antes de las 72 h |

### No objetivos
- No es un ERP ni un sistema contable: no lleva stock, cuentas corrientes ni libros.
- No reemplaza al contador ni la liquidación de impuestos.
- No emite a nombre de terceros con un certificado propio: **cada emisor firma con su certificado** ([ADR-0010](../adr/0010-cada-tenant-es-facturador.md)).

## 3. Actores

| ID | Actor | Descripción | Cómo interactúa |
|---|---|---|---|
| A1 | **Partner** | Empresa de software que integra la plataforma en su producto y la ofrece a sus clientes. Ej.: el software de restaurantes. | API de aprovisionamiento de tenants (v1.0) y soporte asistido (MVP) |
| A2 | **Sistema integrador** | El sistema (ERP, POS) que llama a la API para emitir. Puede pertenecer a un partner o al propio tenant. | API REST con API key y webhooks |
| A3 | **Tenant emisor** | Contribuyente (persona física o jurídica) titular del RUC, timbrado, certificado y CSC. Es la unidad de aislamiento. | Contrato; sus datos fiscales |
| A4 | **Usuario del portal** | Persona del tenant. Roles: `owner`, `admin`, `emisor`, `lector` (p. ej. contador). | Portal web |
| A5 | **Receptor** | Cliente final a nombre de quien se emite el comprobante | Recibe email o WhatsApp; verifica por QR en e-kuatia |
| A6 | **Operador de plataforma** | Soporte y operación interna | Panel de operaciones y runbooks |
| A7 | **SIFEN (DNIT)** | Sistema externo | Servicios web SOAP con mTLS |

**Jerarquía:** `Partner 1 ── N Tenant 1 ── N Usuario`. Un tenant sin partner es un cliente SaaS directo. Un usuario puede pertenecer a varios tenants (caso típico: un contador). El aislamiento por RLS es **por tenant**. El partner solo accede a metadatos operativos de sus tenants (estado, uso, errores) y nunca al contenido de sus documentos, salvo que el tenant lo autorice explícitamente.

## 4. Modelos comerciales

| Modelo | Quién paga | Cómo usa | Release |
|---|---|---|---|
| **M1 — Embebido / white-label** | El partner (volumen de sus tenants) o cada tenant a través del partner | El sistema del partner llama a la API. El operador del restaurante no ve la plataforma. | MVP (piloto con onboarding asistido); v1.0 (aprovisionamiento por API) |
| **M2 — SaaS directo** | El tenant, con suscripción mensual | Portal web con emisión manual y, opcionalmente, su propia API key | v1.0 |

El modelo de datos de suscripciones (planes, suscripciones, métodos de pago, facturas del SaaS, contadores de uso) **existe desde el MVP**. El cobro automático llega en la v1.0.

## 5. Flujos clave

### F1 — Onboarding de un tenant
Es el flujo con más fricción del producto, porque la mitad ocurre fuera de la plataforma.

**Fuera de la plataforma** (lo hace el contribuyente; la plataforma lo guía con un checklist):
1. RUC activo y clave de Marangatu.
2. Habilitación como facturador electrónico en el SGTM: timbrado, establecimientos, puntos de expedición y CSC.
3. Compra del certificado cualificado a un PSC habilitado por el MIC. Debe tener el RUC del tenant y el EKU `clientAuth`.

**Dentro de la plataforma:**
4. Alta del tenant: datos fiscales tal como están en Marangatu y actividades económicas.
5. Establecimientos, puntos de expedición, timbrados y CSC (hasta 2).
6. Carga del certificado `.p12`. La plataforma valida el RUC, el EKU, la vigencia y la cadena, y rechaza el certificado si algo falla.
7. **Verificación en test:** la plataforma emite una FE de prueba en `sifen-test` y muestra el resultado.
8. Paso a producción: el ambiente cambia a `prod` y los literales de test se desactivan.
9. Para M1: se crea una API key y se configura el webhook. Para M2: se invitan usuarios.

MVP: los pasos 4 a 9 los ejecuta un operador (A6) con herramientas internas. v1.0: asistente de onboarding en el portal para M2 y API de aprovisionamiento para partners en M1.

### F2 — Emisión por API
El integrador hace `POST /v1/documents` con `Idempotency-Key`. La plataforma valida, numera, firma y responde **202 con el CDC** en segundos. El KuDE está disponible de inmediato (validación posterior). La aprobación de SIFEN llega de forma asíncrona y se notifica por webhook.

### F3 — Ciclo posterior a la emisión
- **Aprobado:** notificación al receptor.
- **Rechazado:** webhook con el motivo; el integrador corrige y reenvía (mismo CDC si corresponde) o la plataforma inutiliza el número y reemite.
- **Cancelación e inutilización** dentro de plazo.
- **Alertas** cuando un DE se acerca a las 72 h sin aprobación.

### F4 — Notificación al receptor
Canales por comprobante (`email`, `whatsapp`) con política por defecto del tenant. Se envían el XML del receptor y el KuDE en PDF. El remitente y la marca son los del tenant.

### F5 — Portal: consulta y resumen
El usuario ve sus comprobantes, su estado y el detalle (incluido el motivo de rechazo), descarga el XML y el KuDE, y ve un resumen del período: cantidad y monto por tipo y por estado, rechazos y pendientes.

### F6 — Emisión manual desde el portal (v1.0)
Formulario para FE, NCE y NDE, con clientes y productos frecuentes.

### F7 — Suscripción y cobro (v1.0)
Plan, cupo mensual, cobro recurrente con Bancard o Pagopar, aviso al 80 % y política al 100 % (bloqueo, excedente o upgrade).

### F8 — Eventos del receptor (MVP, rol receptor)
Para tenants que también reciben DTE: conformidad, disconformidad, desconocimiento y notificación de recepción. La batería de pruebas de la DNIT los incluye.

## 6. Requerimientos funcionales

La etiqueta de release indica cuándo entra cada requerimiento. **MVP** = primer tenant emitiendo en producción.

| ID | Requerimiento | Release |
|---|---|---|
| RF-01 | Emitir FE, NCE, NDE, AFE y NRE vía API | MVP |
| RF-02 | Respuesta asíncrona (202 + CDC) con webhook firmado del resultado final | MVP |
| RF-03 | Idempotencia por `Idempotency-Key` | MVP |
| RF-04 | Validar el payload y las reglas SIFEN **antes** de enviar, y devolver errores con referencia a la regla | MVP |
| RF-05 | Transmitir por lote (camino principal) y por sincrónico (si el RUC está habilitado) | MVP |
| RF-06 | Consultar el estado de un DE por id o CDC | MVP |
| RF-07 | Corregir y reenviar un DE rechazado | MVP |
| RF-08 | Cancelar un DTE dentro de plazo | MVP |
| RF-09 | Inutilizar rangos de numeración | MVP |
| RF-10 | Eventos del receptor (4 tipos + corrección) | MVP |
| RF-11 | KuDE en PDF (formatos carta y cinta) con QR | MVP |
| RF-12 | Envío por email al receptor con XML y KuDE | MVP |
| RF-13 | Portal: login, listado con filtros, detalle, estado, descargas, resumen del período | MVP |
| RF-14 | Gestión de API keys y webhooks por tenant | MVP (por operador) / v1.0 (autoservicio) |
| RF-15 | Configuración fiscal del tenant y carga validada del certificado | MVP (por operador) / v1.0 (autoservicio) |
| RF-16 | Auditoría de toda operación de escritura, consultable por el tenant | MVP (registro) / v1.0 (consulta en portal) |
| RF-17 | Entidades de suscripción, planes y uso | MVP (modelo y contadores) |
| RF-18 | Envío por WhatsApp | v1.0 |
| RF-19 | Emisión manual desde el portal | v1.0 |
| RF-20 | Asistente de onboarding (M2) y API de aprovisionamiento para partners (M1) | v1.0 |
| RF-21 | Cobro recurrente, cupos y excedentes | v1.0 |
| RF-22 | Dashboard con KPIs y panel de operaciones | v1.0 |
| RF-23 | Branding por tenant en el portal (dominio propio), el KuDE y los correos | v1.0 (correo y KuDE) / v1.1 (dominio propio) |
| RF-24 | SSO empresarial, reportes fiscales y exportaciones | v1.1 |
| RF-25 | Evento de actualización de datos del transporte (NRE) | v1.1 |
| RF-26 | FEE, FEI y Comprobante de Retención | v1.1, **condicionado** a que la DNIT los habilite |
| RF-27 | Nominación de Factura Electrónica: el emisor nombra al comprador de una FE emitida a receptor innominado (NT 014/015/027) | MVP |

## 7. Requerimientos no funcionales

| ID | Requerimiento | Meta |
|---|---|---|
| RNF-01 | Aislamiento multi-tenant | RLS forzado; rol de la app sin `BYPASSRLS`; test de aislamiento como gate de release |
| RNF-02 | Custodia de secretos | Certificados y CSC cifrados con KMS; nunca en disco, logs ni respuestas |
| RNF-03 | Disponibilidad de la API de emisión | 99,5 % (MVP), 99,9 % (v1.0). Si SIFEN cae, la API sigue aceptando |
| RNF-04 | Latencia de `POST /v1/documents` | p95 < 1,5 s (hasta firma y 202) |
| RNF-05 | Integridad ante SIFEN | 0 CDC duplicados; nunca reenviar sin respuesta definitiva |
| RNF-06 | Plazos SIFEN | Alertas escalonadas antes de las 72 h; validaciones de plazo de eventos |
| RNF-07 | Protección del RUC ante bloqueos | Invariantes de lote, validación XSD y pausa automática ante bloqueo |
| RNF-08 | Trazabilidad | `trace_id` desde el request hasta SIFEN y la notificación; auditoría con hash encadenado |
| RNF-09 | Conservación | XML y KuDE conservados por el plazo legal (a confirmar con un contador); backups PITR |
| RNF-10 | Throughput | 20 DE/s sostenidos por instancia (MVP); escalado horizontal |
| RNF-11 | Evolución regulatoria | Nuevos tipos de DE o notas técnicas sin tocar el núcleo (adaptadores y builders por tipo) |
| RNF-12 | Invisibilidad (M1) | Ninguna referencia a la plataforma visible para el usuario final del partner |

## 8. Métricas de producto

- Tiempo desde el alta del tenant hasta la primera FE aprobada en producción.
- Tasa de aprobación al primer envío (meta > 97 %).
- DE que superan 72 h sin aprobación (meta 0).
- Tiempo de integración de un nuevo integrador.
- Tenants activos por modelo (M1/M2), DE por mes y churn (v1.0).

## 9. Fuera de alcance del MVP
Autoservicio de onboarding, cobro automático, WhatsApp, emisión manual desde el portal, dashboards avanzados, dominio propio, SSO, reportes fiscales y app móvil. Todos tienen release asignado en el [roadmap](../roadmap.md).

## 10. Supuestos y preguntas abiertas

### Decisiones tomadas por el orquestador (revisables)
- El **MVP** es de modelo M1 (embebido), con un solo partner: el software de restaurantes propio, más la propia empresa como primer tenant.
- El MVP incluye los 5 tipos de DE y los eventos de receptor, porque la batería mínima de la DNIT los contempla. Recortarlos pone en riesgo el paso a producción.
- El onboarding del MVP lo hace un operador; el autoservicio llega en la v1.0.

### Preguntas para el dueño de producto
| # | Pregunta | Impacto |
|---|---|---|
| P1 | ¿Qué restaurante o cliente es el piloto del MVP? ¿Tiene RUC y está dispuesto a comprar el certificado? | Define el gate de salida del MVP |
| P2 | Tamaño real del equipo y dedicación | Las estimaciones del roadmap suponen el equipo base descrito allí |
| P3 | Precios de los planes (M2) y esquema comercial del partner (M1) | Necesario antes de la v1.0 |
| P4 | ¿Proveedor de WhatsApp: Meta directo o intermediario? ¿Número compartido o del tenant? | v1.0 |

### Preguntas para la DNIT (acción del dueño de producto en la Fase 0)
| # | Pregunta |
|---|---|
| D1 | ¿La habilitación en producción exige presentar evidencia de la batería de pruebas, o es autogestionada? |
| D2 | Literal de ambiente de test: resuelto en papel por la Guía de Pruebas 2026 §2 ("DOCUMENTO ELECTRÓNICO SIN VALOR COMERCIAL NI FISCAL - GENERADO EN AMBIENTE DE PRUEBA"); confirmar con el Prevalidador |
| D3 | Canonicalización y `X509IssuerSerial` en la firma: **resuelto** por NT 016 (c14n inclusiva/exclusiva válidas; KeyInfo solo `X509Certificate`, sin `X509IssuerSerial`) |
| D4 | Notas técnicas vigentes posteriores a v150 (incluida la contingencia) |
| D5 | ¿Cómo se habilita el servicio sincrónico para un RUC? |
