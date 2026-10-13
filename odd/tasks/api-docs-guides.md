# Guías Markdown en /docs/guides

- Feature: `api-docs-guides` · Refs: PO request (docs browsable from the API docs surface)
- Engram mirror: `odd/api-docs-guides/tasks` (pending)
- TDD: strict (source: project config) · runner: Vitest (`pnpm --filter @sifen/api exec vitest run`)
- Delivery: `single-pr` (under 400 authored lines excluding the lockfile and the generated spec)

## Objective

Browse every `docs/**/*.md` as formatted pages from the API docs surface: `GET /docs/guides` (index by
folder, titles from the first `# heading`) and `GET /docs/guides/<path>.md`. Same gate as `/docs`.

## Design

- Hexagonal inside `modules/api-docs`: `domain/guide-links.ts` (link rewriting, titles), ports
  `GuideCatalog` and `MarkdownRenderer`, use case `GuideBrowser`; adapters `FsGuideCatalog` and
  `MarkdownItRenderer` (markdown-it 14.1.0, `html: false`).
- Security: allowlist of `.md` files built once at startup; requests are looked up by exact key and never
  joined to the filesystem; symlinks skipped; missing folder gives an empty index.
- CSP: no `script-src`; static HTML and CSS only. Links to non-md files render as plain text.
- Config: `API_DOCS_GUIDES_DIR` (documented in `docs/configuracion.md`).

## Tasks

- [x] T1 Link rewriting and titles (unit, RED then GREEN)
- [x] T2 Allowlist catalog, config resolution and renderer (unit)
- [x] T3 Controller, module wiring and e2e (index, nested ADR, traversal 404, gate off, CSP, escaped script)
- [x] T4 Redoc description links to the guides; `docs/api/openapi.json` regenerated
- [x] T5 Docs (`docs/configuracion.md`)

Route: inline single writer (one cohesive module).
