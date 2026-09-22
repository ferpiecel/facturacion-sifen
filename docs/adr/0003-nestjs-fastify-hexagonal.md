# ADR-0003: NestJS con Fastify y dominio libre de framework

- **Estado:** Aceptado
- **Fecha:** 2026-09-22

## Contexto
Se quiere arquitectura hexagonal con DI, módulos, guards e interceptors, y la afinidad con Spring facilita la adopción por el equipo.

## Decisión
El backend usa **NestJS con el adaptador Fastify**. Las carpetas `domain/` y `application/` son **TypeScript puro**, sin decorators ni imports de `@nestjs/*`, y se ensamblan con `useFactory` en el módulo. `dependency-cruiser` en CI hace cumplir la regla. La API y los workers son dos entrypoints del mismo código. No se usa `@nestjs/cqrs`: alcanza con handlers simples y eventos de dominio publicados a BullMQ.

## Consecuencias
El dominio es testeable sin framework y los adaptadores se pueden intercambiar. Hay algo más de código de ensamblado en los módulos.

## Alternativas descartadas
Express pelado; Fastify con DI manual (awilix); AdonisJS.
