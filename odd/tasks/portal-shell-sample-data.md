# Portal: reemplazar los datos de muestra

Objetivo: el panel y el encabezado dejan de mostrar datos de ejemplo y usan la API. Modo TDD: estricto, Vitest.

## Tareas

- [x] T1 (PR 1) Empresa activa y rol del usuario desde `/auth/me` + `/auth/tenants` (contexto `IdentityProvider`).
- [ ] T2 (PR 2) "Comprobantes recientes" con `GET /portal/documents?pageSize=5`.

## Pendiente de API

`/auth/me` no devuelve el nombre del usuario (solo `userId` y `activeTenant`). Mientras tanto el pie del menú
muestra "Mi cuenta" y el rol. Mostrar el nombre requiere agregar `displayName` a `/auth/me` (función
`SECURITY DEFINER` sobre `users`, con migración y prueba de RLS).
