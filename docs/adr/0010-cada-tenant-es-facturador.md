# ADR-0010: Cada tenant es facturador electrónico con su propio certificado

- **Estado:** Aceptado
- **Fecha:** 2026-09-22

## Contexto
El certificado de mTLS debe contener el RUC del emisor responsable de la transmisión (Guía de Pruebas 2026, §4.1) y el RUC del certificado debe coincidir con `dRucEm`.

## Decisión
La plataforma **no** firma ni transmite con un certificado propio en nombre de terceros. Cada tenant debe estar habilitado ante la DNIT y cargar su certificado. El onboarding (PRD F1) guía los trámites externos y valida el certificado antes de activar la emisión.

## Consecuencias
Genera fricción en el onboarding, sobre todo en el modelo embebido: cada restaurante hace sus trámites. Se compensa con un buen checklist, la verificación en test y soporte asistido.

## Alternativas descartadas
Emisión centralizada con un certificado de la plataforma (no admitida por SIFEN).
