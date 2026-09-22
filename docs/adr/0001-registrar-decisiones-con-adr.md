# ADR-0001: Registrar decisiones con ADR

- **Estado:** Aceptado
- **Fecha:** 2026-09-22

## Contexto
Las decisiones de arquitectura quedaban dispersas en el plan técnico. El equipo, y los agentes de IA que colaboran en el desarrollo, necesitan saber qué se decidió y por qué, sin volver a discutirlo.

## Decisión
Cada decisión significativa se registra como ADR en `docs/adr/`, en formato MADR corto: contexto, decisión, alternativas y consecuencias. Un ADR no se edita para cambiar la decisión: se crea uno nuevo que lo reemplaza y el anterior pasa a estado *Reemplazado por ADR-XXXX*.

## Consecuencias
Hay una fuente única de verdad para las decisiones. Revisar un PR incluye comprobar que no contradice un ADR vigente.

## Alternativas descartadas
Mantener las decisiones solo en el plan técnico: se pierde el historial y es difícil de referenciar.
