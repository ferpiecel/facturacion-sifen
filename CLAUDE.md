# Reglas del proyecto facturacion-sifen

Instrucciones para cualquier persona o agente que trabaje en este repositorio. Las **reglas de oro** no se negocian; si una tarea no puede cumplirlas, se frena y se consulta.

## Reglas de oro

1. **Una tarea, una rama, un PR.** Cada tarea nueva (historia del backlog, cambio SDD o slice de un cambio) se trabaja en su propia rama, creada desde `main` o, si depende de un PR sin mergear, desde la rama de ese PR (ver [PRs encadenados](#prs-encadenados)).
2. **Todo PR apunta a `main` y pasa una revisión de código antes del merge.** Un agente revisa el diff y publica sus hallazgos como comentario en el PR. Se mergea solo con el CI en verde y sin hallazgos bloqueantes abiertos. El líder técnico (humano o agente autorizado por el dueño del producto) hace el merge con *squash*.
3. **Nada se pushea directo a `main`**, salvo commits de solo documentación de planificación (`docs:`) autorizados por el líder técnico.
4. **Commits convencionales, sin atribución de IA.** Nunca `Co-Authored-By` ni menciones a herramientas de IA en commits ni PRs.
5. **La descripción del PR va en español** y sigue la plantilla [`.github/pull_request_template.md`](.github/pull_request_template.md). Las secciones que no apliquen se completan con "No aplica", no se borran.
6. **Máximo 400 líneas cambiadas por PR** (sin contar `pnpm-lock.yaml`). Si una tarea supera el límite, se divide en PRs encadenados.
7. **Nunca se suben credenciales** (certificados `.p12`, CSC reales, `.env`). Solo `.env.example` con valores de ejemplo.

## Ramas

Formato: `<tipo>/<referencia>-<descripcion-corta>`, en minúsculas y kebab-case.

| Parte | Valores |
|---|---|
| `tipo` | `feat`, `fix`, `refactor`, `test`, `docs`, `ci`, `chore` |
| `referencia` | ID de la historia en minúsculas (`hu-e0-01`) o, si no hay historia, un nombre corto del cambio |
| `descripcion-corta` | 2 a 5 palabras |

Ejemplos: `feat/hu-e0-01-workspace-ci`, `feat/hu-e5-01-post-documents`, `fix/hu-e8-02-cancelacion-4004`, `docs/reglas-git-y-prs`.

### PRs encadenados

Cuando una tarea depende de otra que todavía no se mergeó:

1. La rama nueva sale de la rama anterior, no de `main`.
2. El PR se abre contra `main` **como borrador**, con `Depende de #<número>` en la descripción.
3. Cuando el PR anterior se mergea, se rebasea la rama sobre `main` (`git rebase --onto main <rama-anterior>`, porque el squash cambia los commits) y el PR pasa a "listo para revisión".

## Revisión de código

1. Con el PR abierto, un agente revisa el diff completo buscando bugs reales: condiciones invertidas, validaciones faltantes, errores no manejados, violaciones de los ADRs y de las reglas de SIFEN.
2. Los hallazgos se publican como comentario en el PR, con archivo, línea, escenario de falla y severidad.
3. Los hallazgos bloqueantes se corrigen en la misma rama y se vuelve a revisar. Los no bloqueantes se corrigen o se registran como deuda en la sección "Validaciones pendientes".
4. El merge se hace solo con el CI en verde y la revisión sin bloqueantes.

## Commits

Formato [Conventional Commits](https://www.conventionalcommits.org/), en inglés:

```text
<type>(<scope>): <imperative summary, max 72 chars>

<body: what and why, not how>

Refs: HU-E0-01
```

- `type`: `feat`, `fix`, `refactor`, `test`, `docs`, `ci`, `chore`, `perf`, `build`.
- `scope`: módulo o área (`api`, `workspace`, `architecture`, `dev`, `openspec`, `emision`, `transmision`…).
- Un commit es una unidad lógica que compila y pasa sus tests. El código viaja con sus tests y su documentación.
- El pie `Refs:` apunta a la historia del backlog cuando existe.

## Descripción de los PRs

Título en formato convencional y en español: `feat(api): módulo health de referencia (HU-E0-03)`.

El cuerpo sigue la plantilla del repositorio. Cada sección responde una pregunta concreta:

| Sección | Pregunta que responde |
|---|---|
| Resumen | ¿Qué hace este PR en dos o tres líneas? |
| Qué es nuevo | ¿Qué no existía antes? |
| Qué cambia | ¿Qué comportamiento o archivo existente se modifica? |
| Lógica y casos de uso | ¿Cómo funciona y qué escenarios cubre? |
| Endpoints | Método, ruta, request, response y errores de cada endpoint nuevo o modificado |
| UI | Pantallas o componentes nuevos o modificados, con capturas |
| Pruebas | Tests unitarios, de integración y e2e: qué cubren, comando y resultado |
| Validaciones | Qué se validó (con evidencia) y qué falta validar |
| Trazabilidad | Historias, ADRs y artefactos SDD relacionados |
| Riesgos y rollback | Qué puede salir mal y cómo se revierte |

## Documentación de referencia

- Producto: [`docs/prd/prd.md`](docs/prd/prd.md) · Plan: [`docs/roadmap.md`](docs/roadmap.md) · Backlog: [`docs/backlog/mvp.md`](docs/backlog/mvp.md)
- Decisiones: [`docs/adr/`](docs/adr/README.md) · Diseño técnico: [`docs/plan/plan-desarrollo-v1.1.md`](docs/plan/plan-desarrollo-v1.1.md)
- Normativa DNIT: [`docs/referencia/dnit/`](docs/referencia/dnit/). Las notas técnicas prevalecen sobre el Manual Técnico ([ADR-0012](docs/adr/0012-precedencia-documentacion-oficial.md)).
- Cambios SDD: [`openspec/changes/`](openspec/changes/)
