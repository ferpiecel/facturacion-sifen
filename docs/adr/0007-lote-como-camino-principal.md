# ADR-0007: Transmisión por lote como camino principal

- **Estado:** Aceptado
- **Fecha:** 2026-09-22

## Contexto
El servicio sincrónico requiere que el RUC esté habilitado (validación 1264). La Guía de mejores prácticas de la DNIT (oct/2024) organiza el flujo alrededor de lotes: hasta 50 DE, un RUC, un tipo, ≤ 1000 KB, consulta cada ≥ 10 min, hasta 24 h de procesamiento y consulta válida por 48 h (0364). Ciertos errores de envío bloquean el RUC de 10 a 60 min.

## Decisión
El camino principal es el **lote asincrónico**. El sincrónico es opcional, por tenant, si el RUC está habilitado. `LoteBuilder` hace cumplir las invariantes (un RUC, un tipo, ≤ 50, ≤ 1000 KB, CDC no repetidos ni en otro lote en proceso). Nunca se reenvía sin respuesta definitiva: se recupera el lote consultando por CDC.

## Consecuencias
La API responde 202 y la aprobación es asíncrona (ADR-0011). El KuDE se entrega de inmediato gracias a la validación posterior.

## Alternativas descartadas
El sincrónico como camino principal (depende de una habilitación que no está garantizada).
