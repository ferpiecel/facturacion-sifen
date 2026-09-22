# ADR-0014: Jerarquía partner → tenant para el modelo embebido

- **Estado:** Aceptado
- **Fecha:** 2026-09-22

## Contexto
El software de restaurantes (partner) necesita administrar muchos restaurantes (tenants) sin que sus usuarios vean la plataforma. Cada restaurante es un emisor distinto (ADR-0010).

## Decisión
Existe la entidad **partner**, dueña de N tenants. El RLS sigue aislando **por tenant**. El partner tiene sus propias API keys, con scopes de aprovisionamiento y de operación sobre sus tenants, y ve metadatos operativos (estado, uso, errores) pero no el contenido de los documentos salvo que el tenant lo autorice. Los tenants SaaS directos no tienen partner.

## Consecuencias
Hay una política RLS adicional para el acceso del partner, y el test de aislamiento debe cubrir partner ↔ tenant ajeno.

## Alternativas descartadas
Tratar al partner como un tenant más con acceso a otros (rompe el aislamiento).
