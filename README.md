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
| [`Manual-Tecnico-v150.pdf`](docs/referencia/dnit/Manual-Tecnico-v150.pdf) | Sep/2019 | Manual Técnico v150. MD5 `F48D7C820A14723EC14E66BFCB02E0DF`, idéntico al publicado hoy en el portal de la DNIT (republicado en 2023). No coincide con el MD5 del listado de checksums de 2019, que quedó desactualizado. |
| [`notas-tecnicas/`](docs/referencia/dnit/notas-tecnicas/) | Oct/2019 – Mar/2026 | Notas técnicas NT 001 a NT 027 sobre el MT v150. Tienen precedencia sobre el Manual ([ADR-0012](docs/adr/0012-precedencia-documentacion-oficial.md)). |
| [`guia-de-pruebas-e-kuatia-2026-02.pdf`](docs/referencia/dnit/guia-de-pruebas-e-kuatia-2026-02.pdf) | Feb/2026 | Datos del ambiente de test y batería mínima de homologación |
| [`guia-mejores-practicas-envio-de-2024-10.pdf`](docs/referencia/dnit/guia-mejores-practicas-envio-de-2024-10.pdf) | Oct/2024 | Lotes, consulta de lotes y bloqueos por RUC |
| [`checksum-md5-manual-tecnico.pdf`](docs/referencia/dnit/checksum-md5-manual-tecnico.pdf) | 2019 | Checksums MD5 de las versiones del Manual Técnico. No refleja la republicación de 2023. |

### Ejemplos

| Archivo | Nota |
|---|---|
| [`ejemplo-de-firmado-v150.xml`](docs/referencia/ejemplos/ejemplo-de-firmado-v150.xml) | Ejemplo oficial de DE firmado con QR. Sirve como referencia de firma. |
| [`estructura-de-NO-v150.xsd`](docs/referencia/ejemplos/estructura-de-NO-v150.xsd) | ⚠️ **No corresponde a v150** (usa un esquema antiguo). No debe usarse para validar. Los XSD oficiales se publican en `https://ekuatia.set.gov.py/sifen/xsd`. |

## Pendientes antes de codificar

- Analizar el impacto de las notas técnicas NT 001–027 sobre el plan v1.1 y el backlog.
- Contradicciones entre documentos oficiales (ver plan v1.1, §18):
  - **Canonicalización y `KeyInfo`: resuelto por la NT 016.** Se aceptan c14n inclusiva y exclusiva, con o sin comentarios. `KeyInfo/X509Data` define solo `X509Certificate`, así que no se envía `X509IssuerSerial`.
  - **Literal del ambiente de test: resuelto en papel, falta confirmar con el Prevalidador.** La Guía de Pruebas 2026 (§2) pide `DOCUMENTO ELECTRÓNICO SIN VALOR COMERCIAL NI FISCAL - GENERADO EN AMBIENTE DE PRUEBA`, y por ADR-0012 prevalece sobre el MT.
