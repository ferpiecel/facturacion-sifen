# Facturación Electrónica SIFEN

Plataforma SaaS multi-tenant para emitir documentos electrónicos ante SIFEN (DNIT, Paraguay): generación del XML, firma, envío por lote o sincrónico, KuDE, eventos y notificaciones. Se expone como API y como portal web.

**Stack:** Node.js 22 + TypeScript, NestJS (Fastify), Next.js, PostgreSQL 16 con RLS, Redis + BullMQ, y el ecosistema `facturacionelectronicapy-*` de TIPS S.A.

## Estado

Fase 0 (fundaciones y PoC). Todavía no hay código. Ver [roadmap](docs/roadmap.md).

## Documentación

| Documento | Responde |
|---|---|
| [`docs/prd/prd.md`](docs/prd/prd.md) | **Qué** se construye y para quién: actores, modelos comerciales, flujos, RF/RNF por release, preguntas abiertas |
| [`docs/roadmap.md`](docs/roadmap.md) | **Cuándo**: MVP (4 fases) → v1.0 estable (2 fases) → v1.1 (1 fase), con gates de salida |
| [`docs/backlog/mvp.md`](docs/backlog/mvp.md) | Historias del MVP por épica, con criterios y trazabilidad a SIFEN |
| [`docs/adr/`](docs/adr/README.md) | **Por qué**: decisiones de arquitectura |
| [`docs/plan/plan-desarrollo-v1.1.md`](docs/plan/plan-desarrollo-v1.1.md) | **Cómo**: diseño técnico (arquitectura, modelo de datos, flujos SIFEN, pruebas) |
| [`docs/plan/plan-desarrollo-v1.0.md`](docs/plan/plan-desarrollo-v1.0.md) | Plan original, referencia histórica |

### Referencia oficial (DNIT)

| Archivo | Fecha | Contenido |
|---|---|---|
| `docs/referencia/dnit/Manual-Tecnico-v150.pdf` | Sep/2019 | **Pendiente de agregar.** MD5 esperado: `25EB165A8506EFA3A255B863ABCCAE95` |
| [`guia-de-pruebas-e-kuatia-2026-02.pdf`](docs/referencia/dnit/guia-de-pruebas-e-kuatia-2026-02.pdf) | Feb/2026 | Datos del ambiente de test y batería mínima de homologación |
| [`guia-mejores-practicas-envio-de-2024-10.pdf`](docs/referencia/dnit/guia-mejores-practicas-envio-de-2024-10.pdf) | Oct/2024 | Lotes, consulta de lotes y bloqueos por RUC |
| [`checksum-md5-manual-tecnico.pdf`](docs/referencia/dnit/checksum-md5-manual-tecnico.pdf) | — | Checksums MD5 de cada versión del Manual Técnico |

### Ejemplos

| Archivo | Nota |
|---|---|
| [`ejemplo-de-firmado-v150.xml`](docs/referencia/ejemplos/ejemplo-de-firmado-v150.xml) | Ejemplo oficial de DE firmado con QR. Sirve como referencia de firma. |
| [`estructura-de-NO-v150.xsd`](docs/referencia/ejemplos/estructura-de-NO-v150.xsd) | ⚠️ **No corresponde a v150** (usa un esquema antiguo). No debe usarse para validar. Los XSD oficiales se publican en `https://ekuatia.set.gov.py/sifen/xsd`. |

## Pendientes antes de codificar

- Revisar las notas técnicas vigentes del portal e-kuatia.
- Resolver con el Prevalidador o la mesa de ayuda de la DNIT tres contradicciones entre documentos oficiales: el literal del ambiente de test, la canonicalización y el uso de `X509IssuerSerial` (ver plan v1.1, §18).
