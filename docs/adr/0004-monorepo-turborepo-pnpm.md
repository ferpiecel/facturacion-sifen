# ADR-0004: Monorepo con Turborepo y pnpm

- **Estado:** Aceptado
- **Fecha:** 2026-09-22

## Contexto
La API, los workers, el portal Next.js y los contratos (DTOs, tipos de webhook, SDK) comparten tipos.

## Decisión
Monorepo con **pnpm workspaces + Turborepo**: `apps/api`, `apps/workers`, `apps/portal`, `packages/contracts`, `packages/domain-*` y `packages/config`.

## Consecuencias
Los contratos quedan tipados de punta a punta y los builds son incrementales. El CI es un poco más complejo.

## Alternativas descartadas
Repos separados, con contratos desincronizados.
