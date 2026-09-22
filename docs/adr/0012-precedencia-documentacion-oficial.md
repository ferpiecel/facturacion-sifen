# ADR-0012: Precedencia de la documentación oficial y uso del Prevalidador

- **Estado:** Aceptado
- **Fecha:** 2026-09-22

## Contexto
La documentación de la DNIT tiene contradicciones: el literal del ambiente de test, la canonicalización, `X509IssuerSerial` y el tamaño de lote.

## Decisión
Orden de precedencia: notas técnicas vigentes > Guía de Pruebas 2026 > Guía de mejores prácticas 2024 > MT v150 > ejemplos. Ante una contradicción se aplica el documento más reciente o el más restrictivo, se confirma con el **Prevalidador SIFEN** y, si persiste, se consulta a la mesa de ayuda. Todo valor en disputa es **configurable**, no queda fijo en el código.

## Consecuencias
Se puede corregir sin redeploy cuando la DNIT aclare. El Prevalidador pasa a formar parte del flujo de pruebas.

## Alternativas descartadas
Seguir solo el MT v150 (ignora cambios posteriores).
