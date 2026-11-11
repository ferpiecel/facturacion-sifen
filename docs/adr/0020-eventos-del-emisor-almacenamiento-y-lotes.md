# ADR-0020: Eventos del emisor, almacenamiento y envío en lotes

- **Estado:** Aceptado
- **Fecha:** 2026-10-16

## Contexto

HU-E8-04 es la base de las historias de cancelación (E8-02), inutilización (E8-03), nominación (E8-05) y corrección (E8-01): todas envían eventos firmados a `siRecepEvento` (MT v150, 9.5 y 11), en lotes de hasta 15 de cualquier tipo, y SIFEN responde por evento (`gResProcEVe`, código 0600 si lo registró). El análisis está en `odd/tasks/e8-issuer-events.md`. El puerto del gateway (`enviarEventos`) y los adaptadores TIPS que construyen y firman el evento ya existen (ADR-0015; PR #267 y #269).

## Decisión

1. **Una sola tabla `issuer_events`** con discriminador `kind` (`cancellation`, `voiding`, `nomination`), por decisión del líder técnico: el MT trata los eventos como un grupo genérico con carga tipada. Una cancelación o nominación apunta a un documento (`document_id`, clave foránea compuesta con `tenant_id`); una inutilización lleva su rango en `void_range` y no tiene documento (un `CHECK` lo exige en ambos sentidos). Los eventos del receptor (E9) podrán usar la misma tabla.
2. **`event_id` es el `rEve/@Id`** (1 a 10 dígitos, único por tenant y ambiente). Sale del contador de `dId` del tenant (`nextRequestId`), así que no hace falta otra tabla de secuencias. xmlgen fija `Id="1"`; el adaptador lo reemplaza porque la firma referencia `#<id>` y un lote no puede repetirlo.
3. **Sin tabla de lotes.** A diferencia de los `lotes` de DE, un evento no tiene consulta posterior: SIFEN responde en la misma llamada. El envío se registra en el evento (`batch_d_id`, `send_attempted_at`); los eventos con el mismo `batch_d_id` viajaron juntos. Que un lote no repita `event_id` y tenga como máximo 15 eventos de un emisor lo verifica el batcher (slice C).
4. **Estados:** `pending` (sin firmar) → `signed` → `sending` → `approved` | `rejected` | `unknown`; un `unknown` (envío sin respuesta) puede resolverse después a `approved` o `rejected`. `approved` y `rejected` son finales y guardan `response_code`, `response_message`, `sifen_protocol` (`dProtAut`) y `responded_at`. La respuesta (`response_code`, `responded_at`) viene siempre en par; un `unknown` puede llevarla (como motivo de que se desconoce) o no. Un trigger impide crear un evento que no empiece en `pending`, saltar pasos y salir de un estado final.
5. **Inmutabilidad:** la identidad del evento (`kind`, `event_id`, documento, rango, motivo) no cambia; `signed_xml` y `signed_at` se escriben una vez, al firmar, y no existen antes (un `CHECK` ata el estado `pending` a la ausencia de XML); `batch_d_id` y `send_attempted_at` también son de una sola escritura. Un evento firmado jamás se reenvía tras una respuesta; uno sin respuesta se resuelve consultando, no reenviando (misma disciplina que los lotes, HU-E6-04).
6. **Un evento abierto por documento y tipo.** Un índice único parcial sobre (`tenant_id`, `document_id`, `kind`) excluye los `rejected`: SIFEN refusa el duplicado (4003, 4453) y la plataforma lo evita antes; tras un rechazo se puede pedir de nuevo.
7. **Aislamiento:** `ENABLE` y `FORCE ROW LEVEL SECURITY` con política `FOR ALL` para `app_user` y para `platform_admin`; sin `DELETE`. Un trigger de inserción exige que el evento y su documento pertenezcan al ambiente actual del tenant.
8. **Hora de firma en Asunción:** `dFecFirma` se emite como hora local de Paraguay sin zona, con independencia de la zona del proceso. Es el reloj contra el que SIFEN valida 4008, 4009, 4010 y 4071.
9. **Validaciones del rango de inutilización en el adaptador** (PR #267): fin mayor que inicio (4068) y a lo sumo 1000 números (4067). El resto de las reglas (rango sin DTE aprobado, solapamientos, plazo) son del dominio de E8-03.
10. **Lectura de la respuesta y rechazo local (slice C).** El resultado de cada evento se interpreta con `dEstRes` y todos sus mensajes: 0600 con un estado "Aprobado" aprueba; un estado contradictorio o un mensaje ausente deja el evento `unknown`. Los códigos 4003 (misma cancelación ya pedida) y 4453 (misma nominación) significan que SIFEN ya tiene el efecto: se asientan como `approved` con el código real, nunca como `rejected`, para no liberar el índice único parcial. **Este conjunto es provisional hasta T0** (Prevalidador); el equivalente de inutilización (4066) queda fuera porque también responde a un solapamiento parcial. Un evento que no pasa el XSD se rechaza antes de reclamarse, con el código local `LOC-XSD` (los códigos de SIFEN tienen 4 dígitos) y sin `batch_d_id`; la migración 0049 lo permite solo para `signed → rejected` con un código `LOC-`.

## Consecuencias

- La tabla llega en la migración 0047 y sus guardas en la 0048. El evento se firma una vez y se guarda; el envío en lote, la interpretación de la respuesta y la liquidación sobre el documento (cancelado, inutilizado, nominado) llegan en los slices C y D y en las historias E8-02, E8-03 y E8-05.
- Pendiente de confirmar con el Prevalidador (T0): que SIFEN acepte el evento sin `dTiGDE` dentro de `rEve` (xmlgen no lo emite), el largo del motivo (el MT 11.1.1 dice hasta 150 caracteres para una inutilización; las tablas de campos, 5 a 500; hasta confirmar, el dominio de E8-03 acepta 5 a 150) y el XSD de eventos (todavía no vendorizado).
- Un `unknown` sin recuperación automática queda para el operador hasta que el slice D defina su consulta.

## Alternativas descartadas

- **Una tabla por tipo de evento:** triplica la superficie de RLS y los guards para campos casi idénticos.
- **Tabla de lotes de eventos:** sin consulta posterior no aporta estado propio.
- **Secuencia global de Postgres para `event_id`:** expone el volumen de la plataforma entre tenants y rompe la convención del contador por tenant.
