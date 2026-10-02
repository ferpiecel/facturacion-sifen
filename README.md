# Facturación Electrónica SIFEN

Plataforma SaaS multi-tenant para emitir documentos electrónicos ante SIFEN (DNIT, Paraguay): generación del XML, firma, envío por lote o sincrónico, KuDE, eventos y notificaciones. Se expone como API y como portal web.

**Stack:** Node.js 22 + TypeScript, NestJS (Fastify), Next.js, PostgreSQL 16 con RLS, Redis + BullMQ, y el ecosistema `facturacionelectronicapy-*` de TIPS S.A.

## Estado

Fase 0 (fundaciones y PoC). Ya están el monorepo con CI (HU-E0-01), la API de referencia con el módulo `health` (HU-E0-03) y la validación de XML contra los XSD oficiales de SIFEN (HU-E0-06). Ver [roadmap](docs/roadmap.md).

## Desarrollo local

Requisitos: Node.js 22 y pnpm 12.5.1 (`corepack enable` con corepack ≥ 0.36). Si el corepack de tu Node es más viejo, usá `npx pnpm@12.5.1`.

```bash
pnpm install
pnpm check            # lint, typecheck, depcruise y tests
docker compose up -d  # PostgreSQL 16 y Redis 7
pnpm --filter @sifen/api build && pnpm --filter @sifen/api start
```

### Portal web

El portal del cliente vive en `apps/web` (Next.js + Tailwind v4, diseño SifenFlow de Stitch).

```bash
pnpm --filter @sifen/web dev     # http://localhost:3000, panel de control con datos de ejemplo
pnpm --filter @sifen/web test    # tests de componentes (Vitest + Testing Library)
pnpm --filter @sifen/web build   # build de producción (descarga las fuentes de Google)
```

### Variables de entorno

Todas tienen un valor por defecto, así que el entorno local funciona sin un archivo `.env`. Para cambiarlas, exportalas en tu shell o creá un `.env` local, que nunca se sube al repositorio.

| Variable | Default | Usada por | Descripción |
|---|---|---|---|
| `PORT` | `3000` | `apps/api` | Puerto HTTP de la API. Solo acepta enteros entre 1 y 65535. |
| `POSTGRES_USER` | `sifen` | `docker-compose.yml` | Usuario de PostgreSQL. |
| `POSTGRES_PASSWORD` | `sifen` | `docker-compose.yml` | Contraseña de PostgreSQL. Es solo para desarrollo local. |
| `POSTGRES_DB` | `sifen` | `docker-compose.yml` | Base de datos. |
| `POSTGRES_PORT` | `5432` | `docker-compose.yml` | Puerto de PostgreSQL en el host. |
| `REDIS_PORT` | `6379` | `docker-compose.yml` | Puerto de Redis en el host. |
| `DATABASE_URL` | *(sin valor)* | `apps/api` | Cadena de conexión a PostgreSQL como `app_login`. Sin ella, la API arranca igual y `/health` funciona, pero toda ruta protegida por `ApiKeyGuard` responde `503`. Con `DATABASE_URL` configurada pero la base inalcanzable, la API **no arranca** (comportamiento actual e intencional: falla al inicio en vez de arrancar sin poder autenticar). |
| `SIFEN_ENVIRONMENT` | `test` (o sin valor si `NODE_ENV≠production`) | `apps/api` | `test` o `production`. Determina si se aceptan API keys `sk_test_...` o `sk_live_...`. Con `NODE_ENV=production`, dejarla sin definir hace que la API **no arranca** (fail closed): un despliegue productivo nunca debe arrancar en silencio con `sk_test_...` como aceptación por defecto. |
| `KMS_LOCAL_MASTER_KEY` | *(sin valor)* | `apps/api` | Clave maestra del KMS local (ADR-0009): 32 bytes en base64 estándar con relleno, sin espacios ni saltos de línea (`openssl rand -base64 32`). Envuelve las data keys que cifran CSC y certificados con AES-256-GCM. Es obligatoria salvo con `NODE_ENV` exactamente `development` o `test`: sin ella, la API **no arranca**. En esos dos entornos, sin valor se usa una clave aleatoria descartable (con una advertencia en el log): lo cifrado no sobrevive a un reinicio. Producción debe definir una clave real hasta que exista el adaptador de KMS en la nube, que está pendiente. |
| `NODE_ENV` | *(sin valor)* | `apps/api` | Estándar de Node. En `production` exige `SIFEN_ENVIRONMENT` explícita. Además, solo con `development` o `test` la API puede arrancar sin `KMS_LOCAL_MASTER_KEY`; con cualquier otro valor (o sin valor) la exige. Para desarrollo local, exportá `NODE_ENV=development` o definí la clave. |

## Operación

El operador crea partners, tenants y API keys con el CLI `apps/api/src/cli/ops.ts` (backlog HU-E1-05), nunca a mano en la base. El CLI exige `OPS_DATABASE_URL`: una conexión propia del operador, distinta de `DATABASE_URL` (el rol `app_login`, sujeto a RLS). Sin `OPS_DATABASE_URL` el CLI se niega a arrancar.

```bash
docker compose up -d postgres
DATABASE_URL="postgresql://sifen:sifen@localhost:5432/sifen" \
  pnpm --filter @sifen/db exec drizzle-kit migrate   # como el rol dueño de la base (ver docker-compose.yml)
pnpm --filter @sifen/api build

export OPS_DATABASE_URL="postgresql://sifen:sifen@localhost:5432/sifen"

pnpm --filter @sifen/api ops partner:create --name "Partner Uno"
pnpm --filter @sifen/api ops tenant:create --name "Tenant Directo"
pnpm --filter @sifen/api ops tenant:create --name "Tenant De Partner" --partner <partner-id>
pnpm --filter @sifen/api ops apikey:create --tenant <tenant-id> --env test --scopes documents:write,documents:read --label "CI"
pnpm --filter @sifen/api ops apikey:revoke --key-id <key-id>
pnpm --filter @sifen/api ops fiscal:set --tenant <tenant-id> --ruc 4490207-7 --legal-name "Acme SA" --taxpayer-type juridica --activity 62010:"Programación informática"
pnpm --filter @sifen/api ops establishment:add --tenant <tenant-id> --code 001 --address "Avda. Siempre Viva 123" --house-number 123 --department 11 --district 145 --district-description "Ciudad del Este" --city 3316 --city-description "Ciudad del Este"
pnpm --filter @sifen/api ops establishment:contact --tenant <tenant-id> --establishment 001 --phone 0973-000000 --email emisor@empresa.com.py --name "Casa Matriz"
pnpm --filter @sifen/api ops point:add --tenant <tenant-id> --establishment 001 --code 001
pnpm --filter @sifen/api ops timbrado:add --tenant <tenant-id> --number 12345678 --valid-from 2024-01-01 --valid-to 2025-01-01
read -rs CSC && printf '%s' "$CSC" | KMS_LOCAL_MASTER_KEY="<clave-maestra-base64>" \
  pnpm --filter @sifen/api ops csc:add --tenant <tenant-id> --env test --id 0001 --csc -
read -rs P12_PASSWORD && printf '%s' "$P12_PASSWORD" | KMS_LOCAL_MASTER_KEY="<clave-maestra-base64>" \
  PSC_TRUSTED_ROOTS_PATH=/etc/sifen/psc-roots.pem \
  pnpm --filter @sifen/api ops certificate:add --tenant <tenant-id> --env test --p12 /ruta/segura/tenant.p12 --password -
```

`establishment:add` valida el establecimiento con el dominio de `fiscal-config` antes de tocar la base y persiste todos los campos, incluyendo `--house-number` (dNumCas), los complementos de dirección opcionales (`--address-complement-1`/`--address-complement-2`, dCompDir1/2) y las descripciones de distrito/ciudad (dDesDisEmi/dDesCiuEmi). `--district`/`--district-description` son opcionales en el CLI, igual que en el dominio (cDisEmi tiene ocurrencia 0-1): deben darse ambos o ninguno. `establishment:add` también acepta `--phone`, `--email` y `--name` (dTelEmi, dEmailE y dDenSuc del grupo gEmis; teléfono y correo van juntos), y `establishment:contact` los carga en un establecimiento ya creado. Según el XSD oficial v150 (`DE_v150.xsd`, gEmis) dTelEmi (6 a 15 caracteres) y dEmailE (patrón tEmail) son obligatorios en el DE y dDenSuc (1 a 30) es opcional; por eso la firma de un documento falla si su establecimiento no tiene teléfono y correo. `point:add` resuelve el establecimiento por `(tenant, --establishment)`; si no existe, falla con un error claro en vez de una violación de FK cruda.

`apikey:create` imprime la API key completa (`sk_test_...` / `sk_live_...`) **una sola vez**: no queda guardada en ningún lado más que como hash, así que hay que copiarla en ese momento. El CLI nunca vuelve a loguearla, ni siquiera en `apikey:revoke`.

`csc:add` sella el CSC con el mismo KMS que la API (ADR-0009) y lo guarda en el siguiente slot libre del `(tenant, --env)` (máximo 2; con ambos ocupados falla con un error claro). Exige siempre `KMS_LOCAL_MASTER_KEY` (incluso en development/test: una clave descartable dejaría el CSC irrecuperable) y nunca imprime el CSC. La forma recomendada es `--csc -`, que lo lee de stdin y evita que quede en el historial del shell o en `ps`; `--csc <valor>` también funciona. En tus pruebas usá solo el CSC público de ejemplo (`ABCD0000000000000000000000000000`), nunca uno real en comandos de ejemplo.

`certificate:add` guarda el `.p12` del tenant sellado con el mismo envelope que el CSC (ADR-0009; se sella `{p12, password}` ligado a tenant, ambiente y huella del certificado) después de validarlo: abre el `.p12`, exige que el RUC del certificado coincida con el RUC del perfil fiscal del tenant (`fiscal:set` debe haberse ejecutado antes), `clientAuth`, `digitalSignature`, vigencia y que la cadena llegue a una raíz PSC de confianza. Si algo falla lista todos los motivos y no guarda nada. Las raíces PSC no están en el código: se configuran con `PSC_TRUSTED_ROOTS_PATH`, un archivo PEM con los certificados raíz habilitados por el MIC; sin esa variable el comando falla. Exige `KMS_LOCAL_MASTER_KEY` igual que `csc:add`. La contraseña **solo** se acepta por stdin (`--password -`; `--password <valor>` y `--password=<valor>` se rechazan) y nunca se imprime. Hay un único certificado activo por `(tenant, --env)`: un segundo falla salvo que se pase `--replace`, que revoca el anterior en la misma transacción. Los certificados no se borran, y por eso la huella (fingerprint) de un certificado revocado no se puede volver a cargar para el mismo `(tenant, --env)` (clave única): hay que usar un certificado distinto. El archivo `--p12` debe ser un archivo regular de hasta 64 KiB (se lee con ese tope antes de tocar la base) y el bundle de raíces PSC solo puede contener certificados CA. En pruebas usá solo la PKI de `apps/api/test/support/test-pki.ts`, nunca un `.p12` real.

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
