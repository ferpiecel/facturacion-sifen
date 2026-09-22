# Backlog del MVP

Historias del MVP agrupadas por épica, con la fase en que entran ([roadmap](../roadmap.md)), los criterios de aceptación clave y la trazabilidad a los requerimientos ([PRD](../prd/prd.md)), a las reglas SIFEN (códigos del MT v150) y a la batería mínima de la DNIT (§15.3 del plan).

**Convenciones**
- **ID:** `HU-<épica>-<n>`. Se enumeran solo los criterios que definen si la historia está terminada; los detalles se escriben en Gherkin al tomar la historia (ver el ejemplo al final).
- **Definición de terminado (aplica a todas):** tests unitarios y de integración en verde; test de aislamiento multi-tenant sin regresión; auditoría registrada para las escrituras; OpenAPI actualizado si cambia la API; sin violaciones de `dependency-cruiser`.
- **Tamaño:** S (≤ 2 días), M (3–5 días), L (> 5 días; conviene partirla).

---

## E0 — Fundaciones · F0

| ID | Historia | T | Criterios clave |
|---|---|---|---|
| HU-E0-01 | Como equipo, quiero el monorepo con CI para integrar cambios con seguridad | M | pnpm + Turborepo; lint, typecheck y tests en cada PR; `dependency-cruiser` bloquea `@nestjs/*` en `domain/` y `application/` |
| HU-E0-02 | Como desarrollador, quiero un entorno local con un comando | S | `docker compose up` levanta Postgres 16, Redis 7, MinIO y el mock SOAP de SIFEN |
| HU-E0-03 | Como equipo, quiero una plantilla de módulo hexagonal | S | Generador que crea `domain/`, `application/`, `infrastructure/` y un test de ejemplo |
| HU-E0-04 | Como arquitecto, quiero la PoC con las librerías de TIPS para decidir cuáles se adoptan | L | 1 FE por lote y 1 por sincrónico aprobadas en `sifen-test`; QR verificado en e-kuatia; informe de brechas por librería; ADR-0002 confirmado |
| HU-E0-05 | Como equipo, quiero el mock SOAP de SIFEN con los códigos reales | M | Responde 0300/0301, 0360/0361/0362/0364, 0420/0422, timeouts y bloqueos; escenarios configurables por test |
| HU-E0-06 | Como equipo, quiero validar todo XML contra los XSD oficiales v150 | S | Validador en CI; fixtures del ejemplo oficial; el XSD `estructura-de-NO-v150` queda excluido |

## E1 — Tenancy y acceso · F1

| ID | Historia | T | Criterios clave | Traza |
|---|---|---|---|---|
| HU-E1-01 | Como plataforma, quiero aislar los datos de cada tenant en la base | M | `FORCE RLS` en toda tabla operativa; rol de la app sin `BYPASSRLS`; una query sin tenant seteado falla | RNF-01, ADR-0005 |
| HU-E1-02 | Como plataforma, quiero el contexto de tenant en la API y los workers | M | CLS + `SET LOCAL` en un único punto; `TenantAwareProcessor` para los jobs | ADR-0006 |
| HU-E1-03 | Como plataforma, quiero un test de aislamiento automatizado | M | Intentos cruzados vía API, vía worker y vía SQL directo con el rol de la app: todos fallan; gate en CI | O4 |
| HU-E1-04 | Como integrador, quiero autenticarme con API key | M | Formato `sk_live_`/`sk_test_`; hash Argon2id; scopes; revocación; último uso registrado | RF-14 |
| HU-E1-05 | Como operador, quiero crear partners y tenants | S | CLI o endpoint interno; tenant con o sin partner | ADR-0014 |
| HU-E1-06 | Como partner, quiero ver el estado operativo de mis tenants sin ver sus documentos | M | Política RLS del partner; el test de aislamiento cubre partner ↔ tenant ajeno | ADR-0014 |
| HU-E1-07 | Como usuario del portal, quiero iniciar sesión con MFA y roles | M | Roles owner/admin/emisor/lector; MFA TOTP; un usuario con varios tenants elige el tenant activo | RF-13 |

## E2 — Configuración fiscal del tenant · F1

| ID | Historia | T | Criterios clave | Traza |
|---|---|---|---|---|
| HU-E2-01 | Como operador, quiero registrar los datos fiscales del emisor | S | RUC y DV validados; actividades económicas; tipo de contribuyente y régimen | RF-15 |
| HU-E2-02 | Como operador, quiero registrar establecimientos, puntos de expedición y timbrados | M | Códigos de 3 dígitos; timbrado de 8 con vigencia; ubicación validada contra las tablas oficiales de departamento, distrito y ciudad | Validaciones cruzadas del MT |
| HU-E2-03 | Como operador, quiero cargar hasta 2 CSC por ambiente | S | Cifrados (ADR-0009); nunca se devuelven en claro | §8.8 del plan |
| HU-E2-04 | Como plataforma, quiero ambientes test y prod por tenant | S | En test se aplican los literales obligatorios (configurables, D2); en prod están prohibidos | 1263, ADR-0012 |

## E3 — Certificados · F1 (03 en F3)

| ID | Historia | T | Criterios clave | Traza |
|---|---|---|---|---|
| HU-E3-01 | Como operador, quiero cargar el `.p12` del tenant con validación | M | Rechaza si el RUC no coincide (SerialNumber o SAN, formato `RUCXXXXXXXX-X`), si falta el EKU `clientAuth`, si está vencido o si la cadena no corresponde a un PSC | ADR-0010, §8.7 |
| HU-E3-02 | Como plataforma, quiero custodiar el certificado con envelope encryption | M | KMS; descifrado en memoria; caché LRU con TTL; acceso auditado | ADR-0009 |
| HU-E3-03 | Como tenant, quiero alertas de vencimiento | S | Alertas a 60, 30 y 7 días; bloqueo preventivo de emisión el día anterior al vencimiento | RNF-02 |

## E4 — Numeración · F1

| ID | Historia | T | Criterios clave | Traza |
|---|---|---|---|---|
| HU-E4-01 | Como plataforma, quiero asignar `dNumDoc` de forma atómica | M | Secuencia por (ambiente, timbrado, est., punto, tipo); sin huecos ni duplicados bajo concurrencia (test con 100 emisiones paralelas) | §8.9 |
| HU-E4-02 | Como plataforma, quiero pasar a la siguiente serie al agotar 9999999 | S | Serie AA…ZZ sin Ñ; fecha de inicio registrada | 1110 |
| HU-E4-03 | Como plataforma, quiero generar `dCodSeg` y `dId` | S | `dCodSeg` de 9 dígitos con CSPRNG, distinto de `dNumDoc`; `dId` secuencial por tenant | §8.9 |

## E5 — Emisión de FE · F1

| ID | Historia | T | Criterios clave | Traza |
|---|---|---|---|---|
| HU-E5-01 | Como integrador, quiero emitir una FE con una llamada | L | `POST /v1/documents` → 202 con `document_id` y CDC de 44 dígitos; p95 < 1,5 s | RF-01, RF-02, RNF-04 |
| HU-E5-02 | Como integrador, quiero que mis reintentos no dupliquen comprobantes | M | El mismo `Idempotency-Key` devuelve la misma respuesta; un payload distinto con la misma clave devuelve 409 | RF-03, RNF-05 |
| HU-E5-03 | Como integrador, quiero errores de validación antes de que llegue a SIFEN | M | 422 con la lista de errores (`campo`, `regla`, `código SIFEN` si aplica); cubre redondeo a 50 Gs, receptor innominado ≥ 60 M (1321) y ubicación | RF-04 |
| HU-E5-04 | Como plataforma, quiero generar el XML con xmlgen y validarlo con el XSD | M | Versión SIFEN sin `dInfAdic` (2503) y versión receptor; reglas de formato del MT §7.2.4 | ADR-0002 |
| HU-E5-05 | Como plataforma, quiero firmar el DE | M | XMLDSig enveloped sobre `<DE>`; RSA-SHA256; KeyInfo según D3 (configurable); `fecha_firma` persistida | §8.7 |
| HU-E5-06 | Como plataforma, quiero generar el QR | S | Parámetros en hexadecimal donde corresponde; `cHashQR` con el CSC; URL del ambiente; verificable en e-kuatia | §8.8 |
| HU-E5-07 | Como integrador, quiero consultar un DE por id o CDC | S | `GET /v1/documents/{id}` y `?cdc=`; estado, respuesta SIFEN y URLs | RF-06 |

## E6 — Transmisión a SIFEN · F1 (lote) / F2 (resto)

| ID | Historia | T | Fase | Criterios clave | Traza |
|---|---|---|---|---|---|
| HU-E6-01 | Como plataforma, quiero armar lotes que nunca provoquen bloqueos | M | F1 | Invariantes de `LoteBuilder`: 1 RUC, 1 tipo, ≤ 50, ≤ 1000 KB, sin CDC repetidos ni en otro lote en proceso; property-based tests | ADR-0007 |
| HU-E6-02 | Como plataforma, quiero enviar el lote y guardar el protocolo | M | F1 | mTLS con el certificado del tenant; 0300 guarda `dProtConsLote`; 0301 registra el motivo | Batería: async |
| HU-E6-03 | Como plataforma, quiero consultar el resultado del lote | M | F1 | Primera consulta a los 10 min, luego cada ≥ 10 min; 0361 sigue; 0362 procesa cada DE por `dEstRes` | Batería: resultado lote |
| HU-E6-04 | Como plataforma, quiero recuperarme de un envío sin respuesta | M | F1 | Timeout: **no reenviar**; consultar por un CDC del lote; 0364 o 48 h: consulta por CDC (0420/0422) | Guía 2024 |
| HU-E6-05 | Como plataforma, quiero pausar un tenant bloqueado | S | F2 | Ante un bloqueo: pausa por RUC y reencolado con delay; métrica y alerta | RNF-07 |
| HU-E6-06 | Como tenant habilitado, quiero transmisión sincrónica | M | F2 | Solo si el tenant tiene el flag; 1264 desactiva el flag y cae al lote; `?wait=true` hasta 30 s | Batería: sync |
| HU-E6-07 | Como tenant, quiero alertas antes de las 72 h | S | F2 | `DeadlineWatchWorker` a las 48 h y a las 66 h; webhook `document.transmission_deadline_warning` | ADR-0008, RNF-06 |
| HU-E6-08 | Como plataforma, quiero reintentar con SIFEN caído sin perder DE | M | F2 | Circuit breaker por endpoint; backoff con tope en las 72 h; la API sigue aceptando | ADR-0008, RNF-03 |
| HU-E6-09 | Como plataforma, quiero consultar RUC con caché | S | F2 | `siConsRUC` con caché y TTL; usada para validar receptores | Batería: consulta RUC |

## E7 — Otros tipos de DE · F2

| ID | Historia | T | Criterios clave | Traza |
|---|---|---|---|---|
| HU-E7-01 | Como integrador, quiero emitir una NCE asociada a una FE | M | Documento asociado por CDC; suma de NC ≤ total de la FE (2417); misma moneda (2438) | RF-01; batería: 5+5 sync, 5+5 async |
| HU-E7-02 | Como integrador, quiero emitir una NDE | M | Asociación a la FE; misma moneda | Ídem |
| HU-E7-03 | Como integrador, quiero emitir una AFE | M | Receptor = emisor; vendedor no contribuyente; documento asociado = constancia | Ídem |
| HU-E7-04 | Como integrador, quiero emitir una NRE | L | Sin totales; transporte, salida, entrega, vehículo y transportista obligatorios | Ídem |

## E8 — Rechazos y eventos del emisor · F2

| ID | Historia | T | Criterios clave | Traza |
|---|---|---|---|---|
| HU-E8-01 | Como integrador, quiero corregir y reenviar un DE rechazado | M | `POST /v1/documents/{id}/correct`; si la corrección no toca campos del CDC, mismo CDC; si los toca, la plataforma inutiliza el número y reemite | RF-07, MT §6.5 |
| HU-E8-02 | Como integrador, quiero cancelar un DTE | M | FE ≤ 48 h, otros ≤ 168 h desde la aprobación; bloqueado si hay conformidad (4004); DTE asociados del último al primero | RF-08; batería: 5 cancelaciones |
| HU-E8-03 | Como tenant, quiero inutilizar rangos de numeración | M | ≤ 1000 números; ninguno aprobado; alerta del plazo hasta el día 15 del mes siguiente | RF-09; batería: 2 FE, 1 NCE, 1 NDE, 1 AFE |
| HU-E8-04 | Como plataforma, quiero enviar eventos en lotes | S | ≤ 15 eventos por envío; cada uno firmado | MT §11 |

## E9 — Eventos del receptor · F2

| ID | Historia | T | Criterios clave | Traza |
|---|---|---|---|---|
| HU-E9-01 | Como tenant receptor, quiero registrar conformidad, disconformidad, desconocimiento y notificación de recepción | M | ≤ 45 días desde la emisión; matriz de compatibilidad entre eventos | RF-10; batería: 3 de cada uno |
| HU-E9-02 | Como tenant receptor, quiero corregir un evento | S | ≤ 15 días; una sola corrección por evento | Batería: 3 ajustes de evento |

## E10 — KuDE · F1 (básico) / F2 (completo)

| ID | Historia | T | Fase | Criterios clave | Traza |
|---|---|---|---|---|---|
| HU-E10-01 | Como integrador, quiero el KuDE en PDF de inmediato | M | F1 | Disponible tras la firma; QR ≥ 25 mm; campos obligatorios del MT §13 | RF-11 |
| HU-E10-02 | Como tenant, quiero el KuDE en formato carta y cinta para los 5 tipos | M | F2 | Formato cinta para POS de restaurantes | Batería: 1 KuDE por tipo; 2 consultas QR por tipo |

## E11 — Notificaciones · F1 (webhooks) / F2 (email)

| ID | Historia | T | Fase | Criterios clave | Traza |
|---|---|---|---|---|---|
| HU-E11-01 | Como integrador, quiero webhooks firmados del ciclo de vida | M | F1 | HMAC + marca de tiempo; reintentos con backoff hasta 24 h; DLQ; historial de entregas | RF-02, ADR-0011 |
| HU-E11-02 | Como receptor, quiero recibir mi comprobante por email | M | F2 | XML del receptor + KuDE; remitente del tenant (SPF/DKIM); canal por comprobante o política del tenant | RF-12 |

## E12 — Portal MVP · F2–F3 (frontend en paralelo)

| ID | Historia | T | Criterios clave | Traza |
|---|---|---|---|---|
| HU-E12-01 | Como usuario, quiero listar mis comprobantes con filtros | M | Filtros por tipo, estado, fecha y receptor; paginación; solo del tenant activo | RF-13 |
| HU-E12-02 | Como usuario, quiero ver el detalle y el estado | M | Timeline de estados; motivo de rechazo en lenguaje claro; descarga de XML y KuDE | RF-13 |
| HU-E12-03 | Como usuario, quiero un resumen del período | M | Cantidad y monto por tipo y estado; rechazos; pendientes con el reloj de 72 h | RF-13 |
| HU-E12-04 | Como usuario, quiero ver los DE que necesitan acción | S | Rechazados y cerca de vencer; enlace a corregir o inutilizar | F3 del PRD |

## E13 — Auditoría · F1

| ID | Historia | T | Criterios clave | Traza |
|---|---|---|---|---|
| HU-E13-01 | Como plataforma, quiero registrar toda escritura | M | Actor (usuario o API key), acción, entidad, antes y después con datos sensibles redactados; append-only | RF-16, RNF-08 |
| HU-E13-02 | Como auditor, quiero detectar manipulación del registro | S | Hash encadenado SHA-256; job de verificación diaria | RNF-08 |

## E14 — Operación y paso a producción · F3

| ID | Historia | T | Criterios clave | Traza |
|---|---|---|---|---|
| HU-E14-01 | Como operador, quiero observabilidad de punta a punta | M | OpenTelemetry con `trace_id` del request a SIFEN; métricas de §13 del plan; alertas | RNF-08 |
| HU-E14-02 | Como operador, quiero runbooks | S | SIFEN caído, bloqueo de RUC, certificado vencido, DE a 72 h, restauración de backup | — |
| HU-E14-03 | Como operador, quiero la infraestructura de producción como código | L | Terraform; secretos en Vault; backups PITR y restauración probada | RNF-09 |
| HU-E14-04 | Como operador, quiero hacer el onboarding asistido del piloto | M | Checklist del PRD F1 ejecutado; FE de verificación en test; cambio a prod | PRD F1 |
| HU-E14-05 | Como PO, quiero la evidencia de la batería mínima archivada | S | `docs/homologacion/` con CDC, respuestas y KuDE por escenario | D1 |

## E15 — Modelo de suscripción · F2

| ID | Historia | T | Criterios clave | Traza |
|---|---|---|---|---|
| HU-E15-01 | Como plataforma, quiero las entidades de planes, suscripciones, pagos y facturas del SaaS | M | Tablas y entidades de dominio (plan v1.0 §7.2 Billing); sin cobro todavía | RF-17 |
| HU-E15-02 | Como plataforma, quiero contar el uso por tenant y período | S | Contador atómico por DE emitido, llamada a la API y notificación | RF-17 |

---

## Resumen por fase

| Fase | Épicas | Historias | Capacidad estimada (equipo base) |
|---|---|---|---|
| F0 | E0 | 6 | 3 semanas |
| F1 | E1, E2, E3 (01–02), E4, E5, E6 (01–04), E10-01, E11-01, E13 | 31 | 5 semanas |
| F2 | E6 (05–09), E7, E8, E9, E10-02, E11-02, E12 (01–02), E15 | 21 | 5 semanas |
| F3 | E12 (03–04), E14, E3-03 | 8 | 3 semanas |
| **MVP** | | **66** | **16 semanas** |

## Ejemplo de detalle al tomar una historia (HU-E7-01)

```gherkin
Característica: Nota de Crédito Electrónica

  Antecedentes:
    Dado un tenant con timbrado vigente y certificado válido
    Y una FE aprobada por 1.000.000 PYG con CDC "0180…"

  Escenario: NC parcial dentro del monto
    Cuando envío una NCE por 400.000 PYG asociada al CDC "0180…"
    Entonces la respuesta es 202 con un CDC de 44 dígitos
    Y el documento queda en estado "signed"

  Escenario: La suma de NC supera la FE (2417)
    Dado una NCE aprobada por 700.000 PYG asociada a la FE
    Cuando envío otra NCE por 400.000 PYG
    Entonces la respuesta es 422
    Y el error indica la regla "2417"
    Y no se consume número de documento

  Escenario: Moneda distinta a la de la FE (2438)
    Cuando envío una NCE en USD asociada a la FE en PYG
    Entonces la respuesta es 422 con la regla "2438"
```
