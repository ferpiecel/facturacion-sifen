# ADR-0027: Consulta a eKuatia por CDC con reCAPTCHA v2 (2Captcha): integración de riesgo

- **Estado:** Aceptado
- **Fecha:** 2026-11-06

> **Nota 2026-11-23:** aceptado por el dueño del producto, que ya verificó manualmente una integración con el servicio de captcha y pidió reutilizarla (referencia: la implementación de contahelper, `app/infrastructure/captcha/`). Se mantienen las reglas duras: el agente nunca llama a eKuatia ni a 2Captcha ni lee `.env*`. El contrato de 2Captcha que implementa este repositorio (`TwoCaptchaSolver`) sigue sin ejecutarse contra el servicio real: lo verificado a mano es la integración de contahelper, y el contrato de eKuatia solo se conoce por las capturas humanas.

## Contexto

Un tenant puede conocer solo el CDC de una factura recibida, o el enlace del QR del KuDE, y no tener el XML. La consulta pública de eKuatia devuelve el XML, pero está protegida por reCAPTCHA v2. El proyecto facturaspy la automatiza con el servicio de pago 2Captcha. Su cliente nunca se verificó contra el servicio real: lo único que existe como evidencia son tres capturas guardadas (`requests.json` y `documento.xml` bajo `tests/fixtures/ekuatia/v2026-Q3/`) y la página de consulta. La clave del sitio y los endpoints pueden cambiar sin aviso, y automatizar un sitio público con un resolvedor pagado tiene un riesgo legal y de términos de uso que el dueño del producto debe aceptar.

## Decisión

1. **Camino opcional y con interruptor.** La consulta por CDC es una fuente más de `received_documents` (`ekuatia_cdc`), activada por `RECEPTION_EKUATIA_ENABLED`. Apagada o sin `TWOCAPTCHA_API_KEY`, la API responde `503 ekuatia_unavailable`; nunca `500`.
2. **Puertos.** `EkuatiaClient` y `CaptchaSolver` en `application/ports/`; sus adaptadores (`fetch` de Node 22) viven en `infrastructure/adapters/`. El cliente de 2Captcha es delgado y se prueba contra un servidor HTTP local falso.
3. **Deduplicar antes de resolver.** Si el CDC ya existe para el tenant, se devuelve el documento existente sin gastar una resolución. Un CDC con dígito verificador inválido se rechaza antes de resolver.
4. **Control de gasto.** Tope diario de resoluciones por tenant (`RECEPTION_EKUATIA_DAILY_SOLVE_CAP`) y un corte de circuito cuando el sitio falla repetidamente. Los valores se fijan al implementar R6.3.
5. **Asíncrono.** El `POST` responde 202 y un worker BullMQ (`reception-ekuatia-lookup`) hace la consulta. El XML obtenido pasa por el mismo analizador y los mismos estados que un XML subido.
6. **Evidencia.** Solo las capturas hechas por una persona son fuente de verdad (espíritu de ADR-0012). Los tests reproducen las capturas contra un servidor local. Ningún agente ni ninguna prueba llama a eKuatia o a 2Captcha. El script de captura se niega a correr con `CI` definida o sin `--i-am-a-human`.
7. **Plan B.** Si el flujo falla, el camino de respaldo es subir el XML o el PDF.
8. **Sin datos sensibles en logs.** Los logs llevan ids, conteos y nombres de error; nunca el CDC completo, el XML ni las URLs.

## Consecuencias

La función depende de un tercero frágil y de un servicio de pago. Puede romperse sin cambios de nuestro lado, por eso queda detrás de un interruptor y de topes. El dueño del producto asume los términos de uso y el costo por resolución. Hasta que una persona capture el contrato real, el comportamiento de la primera respuesta del POST y el manejo de cookies quedan sin verificar.

## Alternativas descartadas

- **No ofrecer consulta por CDC:** pierde un caso real (solo se tiene el QR); se mantiene como camino opcional.
- **Resolver el captcha en el navegador del usuario:** requiere interfaz y no sirve para el flujo API-first.
- **Depender de una librería de 2Captcha:** más superficie para un contrato que cabe en dos llamadas HTTP; se reevalúa en el spike R6.1.
- **Consulta síncrona (como facturaspy):** bloquea la petición durante la resolución del captcha, que puede tardar decenas de segundos.

> **Enmienda 2026-11-23 (R6.2):** las capturas `v2026-Q3` guardan solo las respuestas: no registran cabeceras ni cuerpo de la petición, así que el cuerpo del `POST` no tiene respaldo en ellas. El cliente envía `{"cdc": ..., "captcha": <token>}` por convención de las dos implementaciones de referencia (facturaspy y contahelper, esta última un port de la primera: no son pruebas independientes), que declaran no haber verificado el contrato contra eKuatia en vivo; sigue sin verificar. Ambas respuestas traen `set-cookie`, pero no se sabe si el sitio exige reenviarlas; el cliente no las propaga por defecto y ofrece `propagateCookies` (jar en memoria por consulta). Un 404 y el rechazo del captcha tampoco figuran en las capturas.

> **Enmienda 2026-11-23 (R6.3):** valores y decisiones fijados al implementar la consulta por CDC.
>
> - **Tope diario de resoluciones** (decisión 4): por tenant `RECEPTION_EKUATIA_DAILY_SOLVE_CAP` (20) y para toda la plataforma `RECEPTION_EKUATIA_GLOBAL_DAILY_SOLVE_CAP` (100), por día UTC, en las tablas `reception_ekuatia_solve_usage` y `reception_ekuatia_global_usage` (migración 0084). Son valores provisionales conservadores que el dueño del producto debe confirmar (riesgo R-3). El cupo se toma al encolar y se devuelve si la cola rechaza el trabajo o si el worker no llega a resolver (dedupe tardío, interruptor apagado, corte abierto, o el proveedor rechazó la tarea antes de empezar).
> - **Corte de circuito**: `RECEPTION_EKUATIA_BREAKER_FAILURES` (5) fallos consecutivos del resolvedor o del sitio lo abren por `RECEPTION_EKUATIA_BREAKER_COOLDOWN_MS` (15 min); luego deja pasar una sola consulta de prueba. Un saldo agotado, una clave rechazada o una IP no permitida lo abren de inmediato. Un CDC desconocido para eKuatia (`404`) cuenta como sitio sano. El estado es por proceso.
> - **Sin reintentos automáticos**: el trabajo `reception-ekuatia-lookup` corre una sola vez y un trabajo detenido no se reencola, porque cada reintento resolvería otro captcha de pago. Una consulta fallida se pide de nuevo y toma otro cupo. El fallo no deja documento: en esta versión solo queda en los logs del operador.
> - **Respuesta 200 del POST a eKuatia**: el cliente exige un objeto JSON con raíz `DE` (lo único que muestran las capturas); cualquier otro cuerpo, por ejemplo un captcha rechazado con `200`, es `invalid_response` y no se pide el XML. Cómo reporta el sitio un captcha rechazado sigue sin verificarse hasta la captura humana (R6.4).
> - **2Captcha**: la clave viaja en el cuerpo de un `POST` de formulario, no en la URL.
> - **Revisión del PR (R6.3):** el cupo nunca se devuelve si el trabajo puede existir: `enqueued` lo decide la respuesta de `add` (id determinista por tenant y CDC) y un plazo vencido de la cola es un resultado desconocido que conserva el cupo (se prefiere contar de más a gastar una resolución sin contarla). La API y el worker se niegan a arrancar con la consulta disponible y sin almacenamiento de objetos. El `Id` del documento se lee del elemento `DE` con el analizador seguro y debe ser el CDC pedido. El interruptor se lee al arrancar: apagarlo exige reiniciar.
