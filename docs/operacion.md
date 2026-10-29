# Operación

Requiere el entorno de [`desarrollo.md`](desarrollo.md). Variables de entorno en [`configuracion.md`](configuracion.md). Procedimientos ante incidentes (SIFEN caído, RUC bloqueado, certificado vencido, DE a 72 h, backup) en [`runbooks/`](runbooks/README.md).

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
pnpm --filter @sifen/api ops establishment:add --tenant <tenant-id> --code 001 --address "Avda. Siempre Viva 123" --house-number 123 --department 11 --district 145 --district-description "Ciudad del Este" --city 3383 --city-description "Ciudad del Este"
pnpm --filter @sifen/api ops establishment:contact --tenant <tenant-id> --establishment 001 --phone 0973-000000 --email emisor@empresa.com.py --name "Casa Matriz"
read -rs PW && printf '%s' "$PW" | pnpm --filter @sifen/api ops user:create --tenant <tenant-id> --email owner@empresa.com.py --name "Ana Pérez" --role owner --password -
pnpm --filter @sifen/api ops audit:list --tenant <tenant-id> --action document.hold_released --from 2026-10-01 --to 2026-10-31 --limit 50
pnpm --filter @sifen/api ops audit:verify --tenant <tenant-id>
pnpm --filter @sifen/api ops ruc:unblock --tenant <tenant-id> --actor <nombre> --reason "DNIT confirmó que el RUC está habilitado"
pnpm --filter @sifen/api ops document:deadline --within-hours 24
pnpm --filter @sifen/api ops certificate:expiring --days 60
pnpm --filter @sifen/api ops document:release-hold --tenant <tenant-id> --document <document-id>
pnpm --filter @sifen/api ops document:release-holds --tenant <tenant-id> --reason signing:CertificateNotFoundError
pnpm --filter @sifen/api ops correction:release-claim --tenant <tenant-id> --document <document-id> --actor <operador>
pnpm --filter @sifen/api ops point:add --tenant <tenant-id> --establishment 001 --code 001
pnpm --filter @sifen/api ops timbrado:add --tenant <tenant-id> --number 12345678 --valid-from 2024-01-01 --valid-to 2025-01-01
read -rs CSC && printf '%s' "$CSC" | KMS_LOCAL_MASTER_KEY="<clave-maestra-base64>" \
  pnpm --filter @sifen/api ops csc:add --tenant <tenant-id> --env test --id 0001 --csc -
read -rs P12_PASSWORD && printf '%s' "$P12_PASSWORD" | KMS_LOCAL_MASTER_KEY="<clave-maestra-base64>" \
  PSC_TRUSTED_ROOTS_PATH=/etc/sifen/psc-roots.pem \
  pnpm --filter @sifen/api ops certificate:add --tenant <tenant-id> --env test --p12 /ruta/segura/tenant.p12 --password -
```

`establishment:add` valida el establecimiento con el dominio de `fiscal-config` antes de tocar la base y rechaza una dirección que no encaje en la tabla geográfica de la DNIT (departamento, distrito y ciudad deben existir y anidarse; `GET /v1/geo/*` lista los códigos válidos) y persiste todos los campos, incluyendo `--house-number` (dNumCas), los complementos de dirección opcionales (`--address-complement-1`/`--address-complement-2`, dCompDir1/2) y las descripciones de distrito/ciudad (dDesDisEmi/dDesCiuEmi). `--district`/`--district-description` son opcionales en el CLI, igual que en el dominio (cDisEmi tiene ocurrencia 0-1): deben darse ambos o ninguno. `establishment:add` también acepta `--phone`, `--email` y `--name` (dTelEmi, dEmailE y dDenSuc del grupo gEmis; teléfono y correo van juntos), y `establishment:contact` los carga en un establecimiento ya creado (`--name` solo establece el nombre comercial; si se omite se conserva el existente, y el CLI no permite borrarlo). Según el XSD oficial v150 (`DE_v150.xsd`, gEmis) dTelEmi (6 a 15 caracteres) y dEmailE (patrón tEmail) son obligatorios en el DE y dDenSuc (1 a 30) es opcional; por eso la firma de un documento falla si su establecimiento no tiene teléfono y correo. `point:add` resuelve el establecimiento por `(tenant, --establishment)`; si no existe, falla con un error claro en vez de una violación de FK cruda.

`correction:release-claim` libera el reclamo vencido que una reemisión (HU-E8-01, ADR-0021) dejó sobre un documento `rejected` cuando el reemplazo nunca se emitió y el integrador no va a reintentar; mientras existe, toda corrección del documento responde 409 `correction_in_progress`. Rechaza un documento sin reclamo, uno de otro tenant y uno cuyo reemplazo ya existe (se vincula reintentando con la misma `Idempotency-Key`). Audita `correction.claim_released` con el operador (`--actor`). Procedimiento: [runbook](runbooks/correccion-atascada.md).

`document:release-hold` libera un documento que el pipeline de transmisión dejó retenido (`transmission_hold`): sea porque la firma falló con un error determinístico (`signing:<Error>`: falta un dato, el contacto del establecimiento, el CSC o el certificado) o porque se agotaron los reintentos tras 5 rechazos 0301 de lote (`transmission:attempts-exhausted`). Corregí primero la causa (por ejemplo `establishment:contact`, `csc:add`, `certificate:add`), después liberá el documento: borra la retención y reinicia el contador de intentos y la espera, y el próximo ciclo lo retoma. Rechaza un documento que no está retenido o que no es del tenant, e imprime solo los ids y el código liberado. Cada liberación queda en el audit log (`document.hold_released`, con el id y el código anterior). `document:release-holds --tenant <id> --reason <código>` libera de una vez todos los documentos del tenant retenidos por esa causa (por ejemplo tras cargar el certificado que faltaba) e imprime solo la cantidad.

**Documentos retenidos por receptor innominado ("Sin Nombre").** Hasta el arreglo del PR #246, una FE B2C a un receptor sin nombre se aceptaba con 202 pero la firma fallaba siempre con `SigningDataIncompleteError` (faltaba `receiver.name`), así que el documento quedaba retenido con `transmission_hold = 'signing:SigningDataIncompleteError'`. Tras desplegar la versión con el arreglo, liberalos por tenant y el próximo ciclo del worker los firma y los transmite:

```bash
pnpm --filter @sifen/api ops document:release-holds --tenant <tenant-id> --reason signing:SigningDataIncompleteError
```

`--reason` libera todos los documentos del tenant retenidos con ese código, no solo los innominados: cubre cualquier otro payload viejo con datos faltantes, y si alguno vuelve a quedar retenido tras el siguiente ciclo el problema es otro y hay que corregirlo antes de liberar de nuevo. Un innominado retenido con una operación distinta de B2C no se puede recuperar (ahora falla como `InvoiceXmlError`, retención `signing:InvoiceXmlError`): hay que inutilizar su numeración y reemitirlo. Para liberar uno solo, `document:release-hold --tenant <tenant-id> --document <document-id>`. Un innominado solo es válido en B2C y por debajo de 7.000.000 Gs (NT 024, validaciones 1319 y 1321).

`apikey:create` imprime la API key completa (`sk_test_...` / `sk_live_...`) **una sola vez**: no queda guardada en ningún lado más que como hash, así que hay que copiarla en ese momento. El CLI nunca vuelve a loguearla, ni siquiera en `apikey:revoke`.

`csc:add` sella el CSC con el mismo KMS que la API (ADR-0009) y lo guarda en el siguiente slot libre del `(tenant, --env)` (máximo 2; con ambos ocupados falla con un error claro). Exige siempre `KMS_LOCAL_MASTER_KEY` (incluso en development/test: una clave descartable dejaría el CSC irrecuperable) y nunca imprime el CSC. La forma recomendada es `--csc -`, que lo lee de stdin y evita que quede en el historial del shell o en `ps`; `--csc <valor>` también funciona. En tus pruebas usá solo el CSC público de ejemplo (`ABCD0000000000000000000000000000`), nunca uno real en comandos de ejemplo.

`certificate:add` guarda el `.p12` del tenant sellado con el mismo envelope que el CSC (ADR-0009; se sella `{p12, password}` ligado a tenant, ambiente y huella del certificado) después de validarlo: abre el `.p12`, exige que el RUC del certificado coincida con el RUC del perfil fiscal del tenant (`fiscal:set` debe haberse ejecutado antes), `clientAuth`, `digitalSignature`, vigencia y que la cadena llegue a una raíz PSC de confianza. Si algo falla lista todos los motivos y no guarda nada. Las raíces PSC no están en el código: se configuran con `PSC_TRUSTED_ROOTS_PATH`, un archivo PEM con los certificados raíz habilitados por el MIC; sin esa variable el comando falla. Exige `KMS_LOCAL_MASTER_KEY` igual que `csc:add`. La contraseña **solo** se acepta por stdin (`--password -`; `--password <valor>` y `--password=<valor>` se rechazan) y nunca se imprime. Hay un único certificado activo por `(tenant, --env)`: un segundo falla salvo que se pase `--replace`, que revoca el anterior en la misma transacción. Los certificados no se borran, y por eso la huella (fingerprint) de un certificado revocado no se puede volver a cargar para el mismo `(tenant, --env)` (clave única): hay que usar un certificado distinto. El archivo `--p12` debe ser un archivo regular de hasta 64 KiB (se lee con ese tope antes de tocar la base) y el bundle de raíces PSC solo puede contener certificados CA. En pruebas usá solo la PKI de `apps/api/test/support/test-pki.ts`, nunca un `.p12` real.

`certificate:revoke --tenant <id> (--id <uuid> | --fingerprint <sha256-hex>) [--env test|production]` revoca un certificado del tenant (`status = 'revoked'`, `revoked_at`) sin tocar el blob sellado, para que los documentos ya firmados sigan siendo verificables. No necesita `KMS_LOCAL_MASTER_KEY` ni las raíces PSC. Es idempotente (si ya estaba revocado lo informa, no cambia la fecha y no audita de nuevo), un certificado de otro tenant se informa como no encontrado y, si la huella existe en ambos ambientes, exige `--env`. Cada revocación efectiva queda en el audit log (`certificate.revoked`, con id, ambiente y huella). Con el certificado revocado la firma falla con `CertificateNotFoundError` y el pipeline retiene los documentos (`signing:CertificateNotFoundError`) hasta cargar uno nuevo con `certificate:add` y liberarlos con `document:release-holds`.

`user:create --tenant <id> --email <email> --name <nombre> --role owner|admin|emisor|lector [--password -]` da de alta un usuario del portal en el tenant. La contraseña solo se lee de stdin con `--password -` (nunca por argv). El MFA no se carga acá: el usuario lo enrola en su primer ingreso al portal. Si la cuenta (email) ya existía, solo se agrega al tenant con el rol indicado y se ignoran `--name` (que igual es obligatorio) y la contraseña.

`audit:list --tenant <id> [--action <acción>] [--from <YYYY-MM-DD>] [--to <YYYY-MM-DD>] [--limit <1-500, 50 por defecto>] [--after-seq <n>]` lista las entradas del audit log del tenant, de la más vieja a la más nueva, con `seq`, id, fecha, actor (`tipo:id`), acción y entidad. Las fechas son del calendario de Paraguay (UTC-3) y ambos extremos son inclusivos. Pagina por `seq`: si hay más, la última línea es `next: --after-seq <n>`; repetí el comando con ese valor. Nunca imprime `before`/`after` ni el hash. Es solo lectura y corre bajo RLS del tenant. `audit:verify --tenant <id>` recalcula la cadena de hashes del tenant (`verifyAuditChain`, RNF-08) e imprime `audit chain intact: <n> rows (head seq <s>)` o el primer `seq` roto con su motivo; un resultado roto es un incidente de seguridad, no se reintenta ni se "repara".

`document:deadline [--tenant <id>] [--within-hours <1-72, 24 por defecto>] [--limit <1-1000, 100 por defecto>]` lista los documentos firmados que SIFEN todavía no resolvió (`signed`, `queued`, `submitted`) y cuyo plazo de 72 h desde la firma (ADR-0008) vence dentro de la ventana, el más urgente primero, con tenant, id, CDC, estado, firma, vencimiento y horas restantes (los ya vencidos figuran con `0h`). Con `--tenant` lee bajo RLS de ese tenant; sin él recorre todos los tenants como `platform_admin`, el rol cross-tenant deliberado (ADR-0005), y solo lee. `certificate:expiring [--tenant <id>] [--days <1-365>]` lista los certificados activos del ambiente vigente de cada tenant que vencen dentro de la ventana (uno ya vencido pero todavía activo sale con días negativos), con tenant, ambiente, id, huella pública, fecha y días restantes. Sin `--days` usa el umbral mayor de `CERTIFICATE_ALERT_DAYS` (60 por defecto), es decir el primer aviso del worker. Nunca imprime el `.p12`, la contraseña, el XML ni URLs.

`ruc:unblock --tenant <id> --actor <nombre> --reason <motivo>` levanta antes de tiempo la pausa de envíos por RUC bloqueado (HU-E6-05) del tenant. `--actor` y `--reason` son obligatorios (el motivo hasta 500 caracteres). Levanta todas las pausas activas del ambiente vigente del tenant, es decir las que el ciclo del worker todavía respeta; si no hay ninguna activa falla sin escribir nada. Las filas de `ruc_blocks` no se borran: reciben `lifted_at`, `lifted_by` y `lift_reason` (migración `0071`; solo `platform_admin` tiene `UPDATE`, y solo sobre esas columnas), y el guard del ciclo y el gauge `sifen_ruc_blocked_tenants` las ignoran. Queda en el audit log (`ruc_block.lifted`, con el operador, el motivo y el fin original de la pausa). Levantar la pausa no garantiza que SIFEN acepte los lotes: si el bloqueo sigue vigente, el próximo 0301 abre una pausa nueva.

## Alta de un tenant nuevo

Orden recomendado. Dependencias reales: todo exige que exista el tenant; `establishment:contact` y `point:add` exigen el establecimiento (`--establishment`); `certificate:add` exige `fiscal:set`. El resto (`timbrado:add`, `user:create`) solo exige el tenant, así que su orden es libre:

1. `tenant:create`
2. `fiscal:set`
3. `establishment:add` (y `establishment:contact` si faltan teléfono y correo)
4. `point:add`
5. `timbrado:add`
6. `user:create`

Para emitir documentos además hacen falta `apikey:create`, `csc:add` y `certificate:add` (este último exige haber ejecutado antes `fiscal:set`).

## Planes y precios

Los planes son datos de plataforma, no constantes del código. Cada plan tiene filas `plan_prices` con vigencia (`valid_from` y `valid_to`, ambos inclusivos); una restricción `EXCLUDE` impide que dos vigencias del mismo plan se superpongan.

- `plan:seed`: crea los planes del PO (Inicial Gs. 99.000/mes con 100 DE y excedente Gs. 500; PyME 199.000/500/400; Empresa 399.000/2.000/300; Partner a Gs. 300 por DE hasta 10.000 y Gs. 200 desde ahí, en `plan_price_tiers`) y, solo si el plan no tiene ninguna fila de precio, su primer precio vigente desde hoy (día de Paraguay). Es idempotente: repetirlo, o correrlo después de `plan:price-set`, no cambia nada.
- `plan:list`: cada plan con el precio vigente hoy y sus tramos.
- `plan:price-set --plan <código> --monthly <Gs> --included <DE> --overage <Gs> --valid-from <YYYY-MM-DD> [--tier <desde>:<precio>]...`: inserta una fila nueva y cierra el `valid_to` de la anterior el día previo. Nunca hace UPDATE de montos, así el historial queda intacto. `--valid-from` debe ser posterior al último precio; repetir los términos vigentes no hace nada.

La migración `0050` ejecuta `CREATE EXTENSION IF NOT EXISTS btree_gist` (la necesita la restricción `EXCLUDE`). El rol que corre las migraciones debe tener `CREATE` sobre la base de datos, o la extensión debe estar creada de antemano por un superusuario; si no, la migración falla.

## Suscripciones y pagos

- `subscription:assign --tenant <id> --plan <código> [--starts-on <YYYY-MM-DD>]`: suscribe al tenant a un plan. Copia los términos de la fila `plan_prices` vigente en la fecha de inicio (hoy por defecto, día de Paraguay) a la suscripción (`monthly_price`, `overage_price`, `document_quota`), de modo que un cambio de precio posterior no la toca. Un tenant tiene una sola suscripción viva; falla si el plan no tiene precio vigente ese día. Queda en el audit log (`subscription.assigned`).
- `payment:record --tenant <id> --amount <Gs> [--reference <texto>] [--paid-on <YYYY-MM-DD>]`: registra un pago manual contra la suscripción viva del tenant. Los pagos son solo de inserción; un error se corrige con otra fila. Queda en el audit log (`payment.recorded`).

- `tenant:sync-transmission --tenant <id> (--on | --off) --actor <nombre>`: activa o desactiva la transmisión síncrona (`siRecepDE`) del tenant (HU-E6-06). Con el flag activo, un lote de un solo documento se envía de forma síncrona y se resuelve con la respuesta; los lotes de 2 o más siguen por lote. Si SIFEN responde 1264 (RUC no habilitado para sincrónico), el worker apaga el flag solo (auditoría `tenant.sync_transmission_disabled`) y reenvía ese mismo lote por la vía de lote. Auditoría del comando: `tenant.sync_transmission_set`, con `--actor` (obligatorio) como operador. El envío lo sigue haciendo el ciclo del worker (`TRANSMISSION_CYCLE_INTERVAL_MS`), no la API. Requiere perfil fiscal.
- `usage:show --tenant <id> [--period <YYYY-MM>]`: uso del mes de facturación (calendario de Paraguay; el actual por defecto) frente a la cuota y al precio de excedente de la suscripción vigente ese mes (su snapshot, no el precio actual del plan): documentos emitidos, excedente en documentos y en guaraníes, llamadas a la API, notificaciones y un aviso desde el 80 % de la cuota. Solo lee. Los tramos del plan partner no se aplican todavía: se informa el precio de excedente plano del snapshot.

No hay corte por cuota en el MVP: el uso se cuenta y se consulta, no se bloquea.

## Worker de transmisión

Métricas, trazas y reglas de alerta: [`operacion/alertas.md`](operacion/alertas.md).

El worker (`apps/api/src/worker/worker.ts`, mismo código que la API, otro punto de entrada: ADR-0003) corre el ciclo de transmisión de cada tenant (firmar los documentos aceptados, armar lotes, enviar los lotes pendientes y consultar los vencidos) como un job repetible por tenant en la cola BullMQ `lote-build` (ADR-0013). Postgres es la fuente de verdad: Redis solo coordina, y los jobs se reconstruyen al arrancar. Un candado en Redis por tenant evita que dos ciclos del mismo tenant corran a la vez, aunque haya varios procesos worker.

```bash
docker compose up -d postgres redis
pnpm --filter @sifen/api build
export REDIS_URL="redis://localhost:6379"
export DATABASE_URL="<rol app_login>"                      # trabajo por tenant, sujeto a RLS
export WORKER_PLATFORM_DATABASE_URL="<login que puede SET ROLE platform_admin>"  # solo lista tenants
export KMS_LOCAL_MASTER_KEY="<clave-maestra-base64>" PSC_TRUSTED_ROOTS_PATH=/etc/sifen/psc-roots.pem
export SIFEN_GATEWAY=simulator NODE_ENV=development          # ver nota
pnpm --filter @sifen/api worker
```

- **Gateway:** todavía no existe el adaptador real de SIFEN (SOAP). Hasta entonces el worker solo arranca con `SIFEN_GATEWAY=simulator` y `NODE_ENV=development|test`; en producción se niega a arrancar en vez de simular envíos.
- **SIFEN caído (HU-E6-08, ADR-0008):** cada endpoint de SIFEN tiene un circuit breaker compartido por todos los tenants del proceso. Tras 5 fallos de transporte o timeouts consecutivos se abre, el worker deja de llamarlo (cooldown de 30 s que se duplica hasta 15 min, con una sola llamada de prueba) y registra `WARN SIFEN circuit <operación>: closed -> open`. Mientras está abierto, los lotes `pending` quedan sin reclamar (el resumen del ciclo muestra `deferred=<n>`) y la API sigue aceptando documentos, que quedan firmados y encolados. Un lote cuya llamada ya salió y no tuvo respuesta nunca se reenvía: queda `unknown` y se recupera por CDC (HU-E6-04). Los fallos propios de un tenant (sin certificado vigente, certificado rechazado por SIFEN, producción no habilitada) difieren solo el trabajo de ese tenant y no cuentan para el breaker. Cada proceso worker lleva su propio estado de breaker.
- **RUC bloqueado (HU-E6-05):** si SIFEN rechaza un lote con un 0301 cuyo mensaje dice que el RUC está bloqueado, el tenant pausa sus envíos 30 minutos (la Guía 2024 habla de 10 a 60): se guarda una fila en `ruc_blocks`, los documentos del lote vuelven a la cola con espera hasta el fin de la pausa sin gastar un intento, y el ciclo no envía nada más hasta entonces (consultar y recuperar siguen). El worker registra una alerta `ERROR tenant <id> RUC blocked by SIFEN: sends paused until <hora>` y suma al contador `sifen_ruc_blocks_total` (sin etiqueta de tenant; el tenant está en la línea de log); mientras dura la pausa avisa con `WARN ... sends paused until`. El texto exacto que usa SIFEN para el bloqueo está sin confirmar: se detecta la raíz "bloque" sin distinguir mayúsculas ni acentos (`application/ruc-block.ts`), a ajustar tras probar en sifen-test.
- **Logs:** una línea por ciclo con conteos; advertencias (`WARN`) cuando hay documentos retenidos (`held`, usar `document:release-hold` tras corregir la causa), lotes pendientes viejos (`stalePending`) o fallos. Solo ids, conteos y nombres de error: nunca XML, certificados ni URLs.
- **Apagado:** `SIGTERM`/`SIGINT` deja terminar los ciclos en curso antes de salir.
- **Pruebas con Redis real:** `REDIS_URL=redis://localhost:6379 pnpm --filter @sifen/api exec vitest run src/worker`. Sin `REDIS_URL` esas pruebas se omiten; en CI las corre el job `worker-redis`.
