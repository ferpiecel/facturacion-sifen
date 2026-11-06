# ADR-0022: Consulta a eKuatia por CDC con reCAPTCHA v2 (2Captcha): integración de riesgo

- **Estado:** Propuesto
- **Fecha:** 2026-11-06

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
