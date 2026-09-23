# Roadmap — MVP → v1.0 estable → v1.1

Este documento reemplaza la §16 del [plan técnico](plan/plan-desarrollo-v1.1.md). El alcance de cada release está en el [PRD](prd/prd.md) (etiquetas de release en RF) y el detalle del MVP en el [backlog](backlog/mvp.md).

## Resumen

| Release | Fases | Duración estimada | Acumulado | Qué significa |
|---|---|---|---|---|
| **MVP** | F0 → F3 (4 fases) | 16 semanas (rango 14–19) | semana 16 | Un tenant piloto emitiendo **en producción** vía API (modelo embebido), con portal de consulta |
| **v1.0 estable** | F4 → F5 (2 fases) | 8 semanas | semana 24 | SaaS con autoservicio y cobro, WhatsApp, operación a escala; criterios de estabilidad cumplidos |
| **v1.1** | F6 (1 fase) | 6 semanas | semana 30 | White-label avanzado, SSO, reportes, evento de transporte y nuevos DE si la DNIT los habilitó |

```
Sem:  1   3   5   7   9   11  13  15  17  19  21  23  25  27  29
      ├F0─┤├──F1 Núcleo FE──┤├──F2 Cobertura SIFEN─┤├F3─┤
                                  ├── Portal (paralelo) ──┤
                                                    ▲ MVP (prod piloto)
                                                     ├──F4 SaaS──┤├F5┤
                                                     ├ estabilización piloto ┤
                                                                     ▲ v1.0
                                                                      ├──F6──┤
                                                                             ▲ v1.1
```

### Supuestos de estimación
- **Equipo base:** Fer como líder técnico (con dedicación parcial a desarrollo), 2 desarrolladores backend, 1 desarrollador frontend desde la mitad de la F1, y agentes de IA para código repetitivo, tests y documentación. **A confirmar por el dueño de producto (PRD P2).** Con 1 solo backend, sumar un 60–70 % a F1 y F2.
- Los trámites externos (certificado, habilitación) arrancan el **día 1**. Son el camino crítico de la F0 y la F3.
- Las fases tienen **gates**: no se pasa a la siguiente sin cumplir los criterios de salida.

---

## MVP — 4 fases

### F0 — Fundaciones y prueba de concepto (semanas 1–3)
**Objetivo:** eliminar la incertidumbre técnica y regulatoria antes de construir.

| Entregable | Responsable |
|---|---|
| Habilitación en el ambiente de test (SGTM), timbrado de prueba y CSC | PO (trámite) |
| Compra del certificado cualificado (RUC + `clientAuth`) | PO (trámite) |
| Consultas D1–D5 a la DNIT y descarga de las notas técnicas vigentes | PO + orquestador |
| Monorepo, CI (lint, tests, `dependency-cruiser`), Docker Compose local (Postgres, Redis, MinIO) | Equipo |
| Plantilla de módulo hexagonal y ADRs iniciales | Orquestador |
| **PoC:** 1 FE aprobada **por lote** y 1 por sincrónico en `sifen-test`, con las librerías de TIPS (xmlgen + xmlsign + qrgen + setapi) | Backend |
| Prevalidador SIFEN integrado al flujo de desarrollo | Backend |

**Gate de salida:**
- [ ] FE de la PoC aprobada en `sifen-test` y QR verificable en e-kuatia.
- [ ] ADR de las librerías de TIPS confirmado o modificado (qué se usa y qué se reemplaza).
- [ ] D3 (canonicalización/KeyInfo de la firma) resuelto por NT 016; confirmar con el Prevalidador. D2 (literal de ambiente de test) resuelto en papel por la Guía de Pruebas 2026 §2; confirmar con el Prevalidador.
- [x] CI en verde con la regla de dependencias activa.

**Excepción controlada al gate (23/09/2026, decisión del líder técnico con acuerdo del PO).** El gate está bloqueado solo por la PoC real en `sifen-test`, que necesita el certificado cualificado F1 y la habilitación en Marangatu (trámites del PO). Mientras tanto se avanza con lo que **no depende de SIFEN**:

1. PoC **offline**: xmlgen, firma con un certificado de desarrollo autofirmado, QR, validación contra el XSD oficial y envío al simulador `FakeSifenGateway`. Cierra el criterio del ADR de TIPS.
2. Umbral de cobertura ≥85% en el CI.
3. Épicas de F1 independientes de SIFEN: E1 (RLS, contexto de tenant, API keys), E2 (configuración fiscal), E4 (numeración) y E13 (auditoría).

La emisión y la transmisión reales (E5 y E6 contra `sifen-test`) y la batería de homologación **siguen bloqueadas** hasta aprobar la PoC real.

### F1 — Núcleo de emisión de FE (semanas 4–8)
**Objetivo:** el camino feliz completo de la FE, multi-tenant desde el primer commit.

Épicas: E1 Tenancy y acceso, E2 Configuración fiscal, E3 Certificados (carga y custodia), E4 Numeración, E5 Emisión FE, E6 Transmisión (lote), E10 KuDE (versión básica), E11 Webhooks, E13 Auditoría.

**Gate de salida:**
- [ ] El sistema de restaurantes (en su ambiente de desarrollo) emite una FE vía API contra `sifen-test` y recibe el webhook de aprobación.
- [ ] Test de aislamiento multi-tenant en verde en la API **y en los workers**.
- [ ] Idempotencia verificada (el mismo `Idempotency-Key` nunca produce dos CDC).
- [ ] Recuperación de lote sin respuesta y consulta por CDC tras 0364 cubiertas por tests contra el mock SOAP.

### F2 — Cobertura SIFEN completa (semanas 9–13)
**Objetivo:** todo lo que exige la batería mínima de la DNIT.

Épicas: E7 NCE, NDE, AFE y NRE; E8 Rechazos y eventos de emisor; E9 Eventos de receptor; E6 (sincrónico, bloqueos, plazo de 72 h); E10 KuDE carta y cinta; E11 Email; E15 Modelo de suscripción. En paralelo, el frontend construye E12 Portal (listado y detalle).

**Gate de salida:**
- [ ] **Batería mínima completa** ejecutada en `sifen-test` (§15.3 del plan), con la evidencia archivada en `docs/homologacion/`.
- [ ] Todas las reglas de la §8.9 del plan cubiertas por tests.
- [ ] Email al receptor con el XML del receptor y el KuDE.

### F3 — Portal, endurecimiento y producción piloto (semanas 14–16)
**Objetivo:** salir a producción con el piloto.

Épicas: E12 Portal (resumen y pendientes), E14 Operación y paso a producción, E3-03 alertas de vencimiento de certificado.

| Entregable |
|---|
| Portal: login con MFA, listado con filtros, detalle, estado, descargas y resumen del período |
| Observabilidad: métricas SIFEN, alertas de 72 h, bloqueo de RUC y rechazos |
| Runbooks: SIFEN caído, bloqueo de RUC, certificado vencido, DE vencido a 72 h |
| Backups PITR y restauración probada |
| Infraestructura de producción (IaC) |
| Habilitación en producción del tenant piloto y onboarding asistido por un operador |

**Gate de salida = MVP:**
- [ ] El tenant piloto emite FE reales en producción desde el sistema de restaurantes.
- [ ] 2 semanas en producción sin DE perdidos ni duplicados.
- [ ] El piloto consulta sus comprobantes y su resumen en el portal.

---

## v1.0 estable — 2 fases

### F4 — SaaS autoservicio (semanas 17–21)
Mientras tanto, el piloto sigue en **estabilización** (correcciones con prioridad sobre las nuevas funcionalidades).

| Entregable | RF |
|---|---|
| Asistente de onboarding del tenant (M2), con checklist DNIT y verificación en test | RF-15, RF-20 |
| API de aprovisionamiento de tenants para partners (M1) | RF-20 |
| Autoservicio de API keys, webhooks y usuarios | RF-14 |
| Emisión manual desde el portal (FE, NCE, NDE) | RF-19 |
| Planes, cupos, cobro recurrente (Bancard/Pagopar), avisos al 80 % y política al 100 % | RF-21 |
| Consulta de auditoría en el portal | RF-16 |
| Branding del tenant en el KuDE y los correos | RF-23 |

**Gate de salida:** un tenant M2 se da de alta, paga y emite en producción **sin intervención de un operador**.

### F5 — Operación a escala (semanas 22–24)

| Entregable | RF/RNF |
|---|---|
| WhatsApp (Meta Cloud API, plantillas aprobadas) | RF-18 |
| Dashboard de KPIs del tenant y panel de operaciones interno | RF-22 |
| Pruebas de carga (k6) sobre RNF-10 y RNF-04 | RNF-04, RNF-10 |
| Pentest externo y revisión de seguridad de RLS y custodia de certificados | RNF-01, RNF-02 |
| Simulacro de recuperación ante desastres | RNF-09 |
| Documentación pública de la API (OpenAPI + guía del integrador) | O1 |

**Gate de salida = v1.0 estable:**
- [ ] Al menos 3 tenants M1 y 3 tenants M2 en producción.
- [ ] 30 días con disponibilidad ≥ 99,9 % en la API de emisión.
- [ ] 0 incidentes de aislamiento y 0 DE perdidos o duplicados desde el MVP.
- [ ] Pentest sin hallazgos críticos ni altos abiertos.
- [ ] Integración de un integrador nuevo en menos de 5 días usando solo la documentación pública.

---

## v1.1 — 1 fase

### F6 — White-label avanzado y ampliación (semanas 25–30)

| Entregable | RF |
|---|---|
| Portal bajo el dominio del partner o del tenant (CNAME), con branding completo | RF-23 |
| SSO empresarial (OIDC/SAML) | RF-24 |
| Reportes fiscales y exportaciones (CSV/XLSX) | RF-24 |
| Evento de actualización de datos del transporte (NRE) | RF-25 |
| FEE, FEI y Comprobante de Retención, **solo si la DNIT los habilitó**; si no, pasan a v1.2 | RF-26 |
| SDKs para integradores (TypeScript; Java como segundo) | O1 |

**Gate de salida:** el partner de restaurantes opera el portal con su marca y su dominio, y al menos un tenant usa SSO o reportes.

---

## Camino crítico y riesgos del cronograma

| Riesgo | Afecta | Mitigación |
|---|---|---|
| Demora en la compra del certificado o en la habilitación en test | F0 → todo | Iniciar el día 1; la PoC puede avanzar con el mock SOAP y el Prevalidador |
| La DNIT exige evidencia formal para habilitar producción (D1) | F3 | Archivar evidencia de la batería desde la F2 |
| El RUC no queda habilitado para el sincrónico (D5) | F2 | El lote es el camino principal; consultar a la DNIT cómo cubrir esos escenarios |
| Notas técnicas que cambian reglas | F1–F2 | Revisión en la F0; reglas aisladas en validadores por tipo |
| Equipo menor al supuesto | Todo | Recortar el portal del MVP a listado y detalle; el resumen pasa a F4 |
| Librerías de TIPS que no cumplen alguna regla | F1 | Detrás de puertos; reemplazo por adaptador propio o fork |
