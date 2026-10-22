# Operación

Requiere el entorno de [`desarrollo.md`](desarrollo.md). Variables de entorno en [`configuracion.md`](configuracion.md).

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
pnpm --filter @sifen/api ops document:release-hold --tenant <tenant-id> --document <document-id>
pnpm --filter @sifen/api ops document:release-holds --tenant <tenant-id> --reason signing:CertificateNotFoundError
pnpm --filter @sifen/api ops point:add --tenant <tenant-id> --establishment 001 --code 001
pnpm --filter @sifen/api ops timbrado:add --tenant <tenant-id> --number 12345678 --valid-from 2024-01-01 --valid-to 2025-01-01
read -rs CSC && printf '%s' "$CSC" | KMS_LOCAL_MASTER_KEY="<clave-maestra-base64>" \
  pnpm --filter @sifen/api ops csc:add --tenant <tenant-id> --env test --id 0001 --csc -
read -rs P12_PASSWORD && printf '%s' "$P12_PASSWORD" | KMS_LOCAL_MASTER_KEY="<clave-maestra-base64>" \
  PSC_TRUSTED_ROOTS_PATH=/etc/sifen/psc-roots.pem \
  pnpm --filter @sifen/api ops certificate:add --tenant <tenant-id> --env test --p12 /ruta/segura/tenant.p12 --password -
```

`establishment:add` valida el establecimiento con el dominio de `fiscal-config` antes de tocar la base y rechaza una dirección que no encaje en la tabla geográfica de la DNIT (departamento, distrito y ciudad deben existir y anidarse; `GET /v1/geo/*` lista los códigos válidos) y persiste todos los campos, incluyendo `--house-number` (dNumCas), los complementos de dirección opcionales (`--address-complement-1`/`--address-complement-2`, dCompDir1/2) y las descripciones de distrito/ciudad (dDesDisEmi/dDesCiuEmi). `--district`/`--district-description` son opcionales en el CLI, igual que en el dominio (cDisEmi tiene ocurrencia 0-1): deben darse ambos o ninguno. `establishment:add` también acepta `--phone`, `--email` y `--name` (dTelEmi, dEmailE y dDenSuc del grupo gEmis; teléfono y correo van juntos), y `establishment:contact` los carga en un establecimiento ya creado (`--name` solo establece el nombre comercial; si se omite se conserva el existente, y el CLI no permite borrarlo). Según el XSD oficial v150 (`DE_v150.xsd`, gEmis) dTelEmi (6 a 15 caracteres) y dEmailE (patrón tEmail) son obligatorios en el DE y dDenSuc (1 a 30) es opcional; por eso la firma de un documento falla si su establecimiento no tiene teléfono y correo. `point:add` resuelve el establecimiento por `(tenant, --establishment)`; si no existe, falla con un error claro en vez de una violación de FK cruda.

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

## Worker de transmisión

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
- **SIFEN caído (HU-E6-08, ADR-0008):** cada endpoint de SIFEN tiene un circuit breaker compartido por todos los tenants del proceso. Tras 5 fallos de transporte o timeouts consecutivos se abre, el worker deja de llamarlo (cooldown de 30 s que se duplica hasta 15 min, con una sola llamada de prueba) y registra `WARN SIFEN circuit <operación>: closed -> open`. Mientras está abierto, los lotes `pending` quedan sin reclamar (el resumen del ciclo muestra `deferred=<n>`) y la API sigue aceptando documentos, que quedan firmados y encolados. Un lote cuya llamada ya salió y no tuvo respuesta nunca se reenvía: queda `unknown` y se recupera por CDC (HU-E6-04). Cada proceso worker lleva su propio estado de breaker.
- **RUC bloqueado (HU-E6-05):** si SIFEN rechaza un lote con un 0301 cuyo mensaje dice que el RUC está bloqueado, el tenant pausa sus envíos 30 minutos (la Guía 2024 habla de 10 a 60): se guarda una fila en `ruc_blocks`, los documentos del lote vuelven a la cola con espera hasta el fin de la pausa sin gastar un intento, y el ciclo no envía nada más hasta entonces (consultar y recuperar siguen). El worker registra una alerta `ERROR tenant <id> RUC blocked by SIFEN: sends paused until <hora>` y la métrica `metric sifen_ruc_block_total{tenant="<id>"} +1` (una línea de log, todavía no hay backend de métricas); mientras dura la pausa avisa con `WARN ... sends paused until`. El texto exacto que usa SIFEN para el bloqueo está sin confirmar: se detecta la raíz "bloque" sin distinguir mayúsculas ni acentos (`application/ruc-block.ts`), a ajustar tras probar en sifen-test.
- **Correo al receptor (HU-E11-02):** una cola `document-email` aparte (un job repetible por tenant cada 30 s, concurrencia 1) envía el KuDE y el XML firmado de los documentos aprobados. Lee de la tabla `document_emails` (estados `pending`, `failed`, `sent`, `dead`, `skipped`); cada reclamo cuenta como un intento y toma un lease que cubre el peor caso del lote completo (10 filas enviadas en serie, 2 min cada una: 20 min; el timeout SMTP son 30 s por fase), de modo que un envío lento no se reclama de nuevo y un worker caído deja las filas vencidas de nuevo al cumplirse el lease. Si el resultado de un envío no se puede guardar, el worker lo registra como `WARN` (id y número de intento, sin direcciones) y, si hay filas `dead` o sin registrar, deja una línea de conteos por tenant. Los reintentos esperan 1 min, 5 min, 30 min, 2 h y 6 h; agotados, la fila queda `dead`, igual que ante un rechazo permanente (SMTP 5xx) o un KuDE no disponible. `last_error` guarda solo un código clasificado, nunca el texto del proveedor, direcciones ni XML. Con `EMAIL_ENABLED=false` (o sin `SMTP_HOST` en desarrollo) la cola no se crea; las variables están en [`configuracion.md`](configuracion.md). Para reenviar una fila `dead`, tras corregir la causa, ponerla en `pending` con `next_attempt_at` en el pasado y `attempt_count = 0` (plataforma, no desde la API).
- **Logs:** una línea por ciclo con conteos; advertencias (`WARN`) cuando hay documentos retenidos (`held`, usar `document:release-hold` tras corregir la causa), lotes pendientes viejos (`stalePending`) o fallos. Solo ids, conteos y nombres de error: nunca XML, certificados ni URLs.
- **Apagado:** `SIGTERM`/`SIGINT` deja terminar los ciclos en curso antes de salir.
- **Pruebas con Redis real:** `REDIS_URL=redis://localhost:6379 pnpm --filter @sifen/api exec vitest run src/worker`. Sin `REDIS_URL` esas pruebas se omiten; en CI las corre el job `worker-redis`.

