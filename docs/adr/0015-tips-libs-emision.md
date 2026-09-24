# ADR-0015: xmlgen, qrgen y xmlsign (modo Node) detrás de puertos de emisión

- **Estado:** Aceptado
- **Fecha:** 2026-09-24

## Contexto

ADR-0002 adoptó `xmlgen` para el XML y el CDC, pero dejó `xmlsign`, `qrgen` y `setapi` pendientes de evaluación en la PoC de la F0. Esa PoC offline (HU-E0-04) ya construyó, firmó y generó el QR de una DE de prueba sin red y sin JVM, encadenando `xmlgen` → `xmlsign` → `qrgen` → validación XSD → `FakeSifenGateway`.

`xmlsign` soporta dos modos de firma: uno que delega en una JVM embebida (spawnea un proceso Java) y otro puramente en Node.js (`signByNodeJS: true`). El modo JVM exige Java disponible en tiempo de ejecución y de CI, y rompe cualquier garantía de "sin subprocesos" que el resto del pipeline necesita.

`qrgen` no solo construye la URL del QR: devuelve el XML de la DE con el elemento `gCamFuFD` incluido, que `rDE` exige antes de poder validar contra el XSD. El plan técnico (§5.1) describía el puerto como `buildUrl(...): string`, lo cual no refleja ese contrato real.

## Decisión

Se usan `xmlgen`, `qrgen` y `xmlsign` con versiones exactas fijadas (sin rango de semver), envueltos detrás de los puertos framework-free `DeXmlBuilder`, `XmlSigner` y `QrGenerator` definidos en `packages/sifen-gateway/src/emission-ports.ts`. Ninguna de las tres librerías es importada fuera de `packages/sifen-tips`; esto se hace cumplir con una regla de `dependency-cruiser` en la raíz del monorepo.

`xmlsign` se usa **siempre en modo Node** (`signByNodeJS: true`, no configurable). El modo JVM queda descartado: no se invoca en ningún camino de código.

`QrGenerator` se redefine como `addQr(signedXml: string, config: QrConfig): Promise<string>`, reemplazando el `buildUrl(...): string` del plan §5.1, para reflejar que la librería devuelve el XML completo con `gCamFuFD`, no solo una URL.

Donde el Manual Técnico y el XSD publicado por la SET/DNIT diverjan, se sigue el XSD en tiempo de ejecución (ADR-0012).

### Preguntas abiertas

- **D7 — `dSisFact`:** la Nota Técnica 010 eliminó este campo, pero el XSD publicado todavía lo exige. Pendiente de confirmar en sifen-test y con el Prevalidador antes de fijar el comportamiento del builder para producción.
- **D8 — transformaciones de la firma:** la PoC aplica dos transformaciones (`enveloped-signature` + `exc-c14n`) mientras que la Nota Técnica 016 describe una sola. Pendiente de confirmar en sifen-test y con el Prevalidador cuál es el comportamiento aceptado.

Ninguna de las dos bloquea esta decisión: la PoC offline valida contra el XSD publicado y ambas quedan como validaciones pendientes antes de habilitar transmisión real.

## Consecuencias

Los certificados de desarrollo usados en tests se generan en memoria en tiempo de ejecución (con `node-forge`) y nunca se escriben a disco ni se commitean al repositorio.

Si `xmlsign` es rechazado por sifen-test o el Prevalidador por alguna de las preguntas abiertas, el puerto `XmlSigner` permite sustituirlo por un firmador propio sin tocar el resto del pipeline.

## Alternativas descartadas

Firma vía JVM embebida (modo por defecto de `xmlsign`): requiere Java en CI y en runtime, y rompe la garantía de "sin subprocesos" de la PoC offline.

Firmador propio desde el inicio: mayor costo y riesgo de canonicalización incorrecta sin necesidad, dado que `xmlsign` en modo Node cubre el caso de uso y ADR-0002 ya aceptó ese riesgo con puertos y tests de contrato como mitigación.
