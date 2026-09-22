# ADR-0008: Sin emisión en contingencia; cola con plazo de 72 h

- **Estado:** Aceptado
- **Fecha:** 2026-09-22

## Contexto
El plan v1.0 proponía `iTipEmi = 2` cuando SIFEN no está disponible. En MT v150 la contingencia está marcada como futura y SIFEN la rechaza (validación 1050). El modelo de validación posterior da 72 h desde la firma para transmitir.

## Decisión
No se emite en contingencia. Si SIFEN no responde, los DE quedan firmados y encolados, y se reintenta con backoff y circuit breaker. `DeadlineWatchWorker` alerta a las 48 h y a las 66 h. Se revisa esta decisión si una nota técnica habilita la contingencia.

## Consecuencias
La API de emisión sigue disponible con SIFEN caído. Pasadas las 72 h, el DE se aprueba con observación por extemporáneo.

## Alternativas descartadas
`iTipEmi = 2` (rechazado por SIFEN).
