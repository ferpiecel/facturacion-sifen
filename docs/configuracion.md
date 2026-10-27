# Configuración

Variables de entorno de la API, el worker y `docker-compose.yml`. Todas tienen un valor por defecto, así que el entorno local funciona sin un archivo `.env`. Para cambiarlas, exportalas en tu shell o creá un `.env` local, que nunca se sube al repositorio.

Todas tienen un valor por defecto, así que el entorno local funciona sin un archivo `.env`. Para cambiarlas, exportalas en tu shell o creá un `.env` local, que nunca se sube al repositorio.

| Variable | Default | Usada por | Descripción |
|---|---|---|---|
| `PORT` | `3000` | `apps/api` | Puerto HTTP de la API. Solo acepta enteros entre 1 y 65535. |
| `POSTGRES_USER` | `sifen` | `docker-compose.yml` | Usuario de PostgreSQL. |
| `POSTGRES_PASSWORD` | `sifen` | `docker-compose.yml` | Contraseña de PostgreSQL. Es solo para desarrollo local. |
| `POSTGRES_DB` | `sifen` | `docker-compose.yml` | Base de datos. |
| `POSTGRES_PORT` | `5432` | `docker-compose.yml` | Puerto de PostgreSQL en el host. |
| `REDIS_PORT` | `6379` | `docker-compose.yml` | Puerto de Redis en el host. |
| `REDIS_URL` | *(sin valor)* | worker | URL de Redis (`redis://` o `rediss://`) para BullMQ (ADR-0013). Obligatoria para el worker; nunca se escribe en logs ni en errores. Local: `redis://localhost:6379` con `docker compose up -d redis`. |
| `TRANSMISSION_CYCLE_INTERVAL_MS` | `60000` | worker | Cada cuánto corre el ciclo de transmisión de cada tenant (5 s a 1 h). |
| `WORKER_CONCURRENCY` | `4` | worker | Tenants que un proceso worker atiende a la vez (1 a 32). |
| `TENANT_RUN_LOCK_TTL_MS` | `300000` | worker | Vida del candado por tenant en Redis si el proceso muere a mitad de un ciclo (10 s a 1 h). |
| `DEADLINE_WATCH_INTERVAL_MS` | `300000` | worker | Cada cuánto revisa el worker, por tenant, los documentos pendientes que cruzaron las 48 h o las 66 h desde la firma para emitir `document.transmission_deadline_warning` (1 min a 1 h; HU-E6-07). |
| `CERTIFICATE_ALERT_DAYS` | `60,30,7` | worker | Días antes del vencimiento del certificado activo en que se emite `certificate.expiring` (una vez por certificado y umbral; enteros de 1 a 365, separados por coma). La revisión corre con el intervalo de `DEADLINE_WATCH_INTERVAL_MS`. Un valor inválido impide arrancar el worker (HU-E3-03). |
| `CERTIFICATE_EMISSION_BLOCK_DAYS` | `1` | API | Días antes del vencimiento del certificado activo desde los que `POST /v1/documents` (y notas, autofactura) responde `422` con `code: certificate_expiring`, antes de consumir un número (0 a 30; con `0` solo se bloquea al vencer). Sin certificado activo no bloquea: la firma retiene el documento. Un valor inválido impide arrancar la API (HU-E3-03). |
| `CERTIFICATE_CACHE_TTL_MS` | `300000` | worker | Cuánto permanece en memoria un certificado descifrado (1 s a 15 min). Acota la residencia de la clave: las entradas vencidas se borran (con el material en cero) en cada uso y, con el worker inactivo, con un temporizador que corre solo mientras haya entradas, de modo que la clave no sobrevive al TTL más de 30 s; al apagar el worker se borran todas. Cada uso vuelve a verificar en la base que el certificado siga activo y vigente, por lo que una revocación o reemplazo hecho por el CLI bloquea la firma de inmediato. Cada descifrado (no cada uso) queda en el audit log. |
| `CERTIFICATE_CACHE_MAX_ENTRIES` | `64` | worker | Máximo de certificados (tenant y ambiente) en memoria a la vez (1 a 1000); al superarlo se descarta y borra el menos usado. |
| `EMAIL_ENABLED` | *(sin valor)* | worker | Envío del KuDE y el XML firmado al receptor (HU-E11-02). `false` apaga el canal. Sin definir: el worker **no arranca** si falta la configuración SMTP salvo que `NODE_ENV` sea exactamente `development` o `test` (falla cerrado; apagar el canal exige `false` explícito); en esos dos entornos el envío se activa solo si hay `SMTP_HOST`. `true` exige la configuración SMTP. Cualquier otro valor es un error. |
| `SMTP_HOST` | *(sin valor)* | worker | Servidor SMTP de la cuenta única de la plataforma (MVP). Obligatorio si el envío está activo. |
| `SMTP_PORT` | `587` | worker | Puerto SMTP (1 a 65535). `587` usa STARTTLS obligatorio; `465` exige `SMTP_SECURE=true` (si no, el worker no arranca). |
| `SMTP_SECURE` | `false` | worker | `true`: TLS implícito (puerto 465). `false`: STARTTLS, y si el servidor no lo ofrece el envío falla en vez de ir en claro. |
| `SMTP_USER` / `SMTP_PASSWORD` | *(sin valor)* | worker | Credenciales SMTP; se definen las dos o ninguna. La contraseña nunca se escribe en logs ni en errores. |
| `SMTP_ALLOW_PLAINTEXT` | `false` | worker | `true` permite SMTP sin TLS (por ejemplo Mailpit local). Solo con `NODE_ENV` `development` o `test`; en producción es un error. |
| `EMAIL_FROM_ADDRESS` | *(sin valor)* | worker | Dirección remitente de la plataforma (`facturas@ejemplo.com`), la misma para todos los tenants. El nombre visible del `From` es el del tenant. Obligatoria si el envío está activo. Dominios de envío propios por tenant (SPF/DKIM) quedan como seguimiento. |
| `DATABASE_URL` | *(sin valor)* | `apps/api` | Cadena de conexión a PostgreSQL como `app_login`. Sin ella, la API arranca igual y `/health` funciona, pero toda ruta protegida por `ApiKeyGuard` responde `503`. Con `DATABASE_URL` configurada pero la base inalcanzable, la API **no arranca** (comportamiento actual e intencional: falla al inicio en vez de arrancar sin poder autenticar). |
| `SIFEN_ENVIRONMENT` | `test` (o sin valor si `NODE_ENV≠production`) | `apps/api` | `test` o `production`. Determina si se aceptan API keys `sk_test_...` o `sk_live_...`. Con `NODE_ENV=production`, dejarla sin definir hace que la API **no arranca** (fail closed): un despliegue productivo nunca debe arrancar en silencio con `sk_test_...` como aceptación por defecto. |
| `KMS_LOCAL_MASTER_KEY` | *(sin valor)* | `apps/api` | Clave maestra del KMS local (ADR-0009): 32 bytes en base64 estándar con relleno, sin espacios ni saltos de línea (`openssl rand -base64 32`). Envuelve las data keys que cifran CSC y certificados con AES-256-GCM. Es obligatoria salvo con `NODE_ENV` exactamente `development` o `test`: sin ella, la API **no arranca**. En esos dos entornos, sin valor se usa una clave aleatoria descartable (con una advertencia en el log): lo cifrado no sobrevive a un reinicio. Producción debe definir una clave real hasta que exista el adaptador de KMS en la nube, que está pendiente. |
| `AUTH_SUBJECT_PEPPER` | *(sin valor)* | `apps/api` | Secreto (mínimo 32 bytes) con el que se calcula el HMAC-SHA256 de los emails e IP del límite de intentos y de los eventos de autenticación, para que no se puedan revertir por diccionario. Generalo con `openssl rand -base64 48`. Es obligatorio salvo con `NODE_ENV` exactamente `development` o `test` (ahí se usa un valor fijo de desarrollo): sin él, la API **no arranca**. |
| `PORTAL_ORIGIN` | *(sin valor)* | `apps/api` | Origen del portal (`https://app.ejemplo.com`, sin ruta ni barra final) que puede llamar a las rutas `POST /auth/*`; se compara exacto con la cabecera `Origin` (defensa CSRF). Obligatorio salvo con `development` o `test` (ahí, si no se define, `http://localhost:3001`, el puerto del portal; `start:dev` la fija igual): sin él, la API **no arranca**. |
| `API_INTERNAL_URL` | `http://localhost:3000` | `apps/web` | URL base de la API a la que el portal reenvía `/api/auth/*` y `/api/portal/*` (proxy del mismo origen; las cookies `__Host-` quedan en el host del portal y el `Origin` coincide con `PORTAL_ORIGIN`). Solo se exponen `/auth/*` y `/portal/*`. Es una variable de **build**: `next.config.ts` la evalúa en `next build`, y cambiarla después no tiene efecto. |
| `PORTAL_TRUSTED_UPSTREAM_PROXY` | *(sin valor)* | `apps/web` | Con `true`, el portal conserva `X-Forwarded-For`, `X-Real-IP` y `Forwarded` porque delante de Next hay un balanceador de confianza que agrega la IP real. Sin valor, el portal **sobrescribe** `X-Forwarded-For` con la dirección del socket y descarta las otras dos, para que un navegador no elija su IP de límite de intentos. |
| `AUTH_TRUST_PROXY_HOPS` | `0` | `apps/api` | Cantidad de proxies inversos (0 a 3) cuya entrada de `X-Forwarded-For` se acepta para la IP del cliente del límite de intentos. Con `0` se usa la dirección del socket y la cabecera se ignora. Nunca se confía en una cabecera cruda. |
| `SESSION_ACCESS_TTL_SECONDS` | `300` | `apps/api` | Vida del token de acceso del portal (30 a 3600). Decidido por el producto: 5 minutos. |
| `SESSION_REFRESH_TTL_SECONDS` | `600` | `apps/api` | Vida deslizante del token de refresco (60 a 86400). Decidido por el producto: 10 minutos; un usuario ocioso más tiempo que esto vuelve al login. |
| `SESSION_ABSOLUTE_TTL_SECONDS` | `43200` (`1200` con `NODE_ENV` `development` o `test`) | `apps/api` | Tope absoluto desde el login (300 a 604800): ni el refresco lo supera. Decidido por el producto: 12 h en producción y 20 min en desarrollo y test. |
| `API_DOCS_ENABLED` | *(sin valor)* | `apps/api` | `true` publica `/docs`, `/docs/openapi.json` y `/docs/guides` (documentación OpenAPI de la API de integradores, sin API key) aunque `NODE_ENV` no sea `development` o `test`; pensado para staging. Cualquier otro valor se ignora. Sin la variable, en producción o con `NODE_ENV` sin definir, ambas rutas responden `404`. |
| `API_DOCS_GUIDES_DIR` | *(sin valor)* | `apps/api` | Carpeta de Markdown que `/docs/guides` publica como páginas HTML (índice por carpeta y una página por `.md`). Sin la variable se usa `docs/` en la raíz del workspace pnpm (se busca `pnpm-workspace.yaml` subiendo desde el directorio de trabajo). Los `.md` se listan una sola vez al arrancar y solo esos se sirven; si la carpeta no existe (p. ej. en una imagen de producción) el índice queda vacío. Sigue la misma compuerta que `/docs` (`NODE_ENV` o `API_DOCS_ENABLED`). |
| `NODE_ENV` | *(sin valor)* | `apps/api` | Estándar de Node. En `production` exige `SIFEN_ENVIRONMENT` explícita. Además, solo con `development` o `test` la API puede arrancar sin `KMS_LOCAL_MASTER_KEY`; con cualquier otro valor (o sin valor) la exige. Para desarrollo local, exportá `NODE_ENV=development` o definí la clave. |

## IP del cliente y proxies de confianza

La IP que usa el límite de intentos de login es `request.ip` de Fastify, normalizada por `normalizeClientIp` (`apps/api/src/modules/identity/infrastructure/http/client-ip.ts`): IPv4 tal cual, IPv6 colapsada a su /64.

- Con `AUTH_TRUST_PROXY_HOPS=0` (default) se usa la dirección del socket y `X-Forwarded-For` se ignora: el cliente no puede elegir la IP que ve el límite.
- Con `N` entre 1 y 3, Fastify cree solo los primeros `N` saltos del lado del servidor (`apps/api/src/bootstrap/http.ts`) y nada de lo que el cliente antepuso. `N` debe coincidir con la cantidad real de proxies inversos delante de la API, el portal incluido (ver abajo).
- Un valor fuera de 0 a 3 o no entero impide el arranque (`auth-http-config.ts`).

### IP del cliente detrás del portal

La API ve al portal como un proxy más, así que `AUTH_TRUST_PROXY_HOPS` debe contarlo:

- Portal expuesto directamente: `AUTH_TRUST_PROXY_HOPS=1` en la API y `PORTAL_TRUSTED_UPSTREAM_PROXY` sin definir.
- Portal detrás de balanceadores que agregan a `X-Forwarded-For`: `AUTH_TRUST_PROXY_HOPS` = 1 + cantidad de balanceadores, y `PORTAL_TRUSTED_UPSTREAM_PROXY=true` en el portal.
- Un valor mayor que la cadena real permite suplantar la IP con una cabecera enviada por el cliente; con `0` todos los usuarios comparten la IP del portal y un atacante bloquea el login de todos por el límite por IP.
- Next solo completa `X-Forwarded-For` cuando falta y su rewrite no la modifica; por eso el portal fija la dirección en `instrumentation.ts` (el middleware corre demasiado tarde).
