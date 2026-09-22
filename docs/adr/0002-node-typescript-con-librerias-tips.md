# ADR-0002: Node.js + TypeScript con el ecosistema de TIPS detrás de puertos

- **Estado:** Aceptado
- **Fecha:** 2026-09-22

## Contexto
SIFEN exige XML según MT v150, firma XMLDSig, SOAP 1.2 con mTLS y QR con hash. El MT permite cualquier lenguaje. TIPS S.A. publica con licencia MIT la familia `facturacionelectronicapy-*` (xmlgen, xmlsign, qrgen, setapi, kude), que se mantiene activamente y usan varios proveedores locales. El stack más fuerte del equipo es Java/Spring.

## Decisión
Se usa **Node.js 22 LTS + TypeScript**. **xmlgen** se adopta para generar el XML, el CDC y los eventos. **xmlsign, qrgen y setapi** se evalúan en la PoC de la F0. **kude** se toma solo como referencia: el KuDE es propio para permitir branding. Todas se envuelven detrás de puertos del dominio (`DeXmlBuilder`, `XmlSigner`, `QrGenerator`, `SifenGateway`).

## Consecuencias
Se ahorran semanas en la parte más delicada. Hay una dependencia de una librería comunitaria, que se mitiga con puertos, tests de contrato y la opción de hacer un fork. El equipo trabaja fuera de su stack principal; NestJS reduce esa brecha (ADR-0003).

## Alternativas descartadas
Java/Spring con una implementación propia del XML y la firma (más costo inicial y más riesgo en la canonicalización). Un esquema híbrido Spring + sidecar Node (dos runtimes para operar).
