# Reception golden fixtures

Verbatim data, do not edit by hand.

## Provenance

- Source repository: `/home/rodrigo/workspace/facturaspy` (read-only reference project), folder `tests/fixtures/`.
- Source commit: `ab6c76c3cfc7a2c204b439514b19a76900e2e76b`.
- Copy date: 2026-11-06.
- Copied byte-for-byte (`cp`) from `git ls-files tests/fixtures`:
  - `sifen/` (SIFEN `documento.xml` samples and its README)
  - `ekuatia/` (README, `v2026-Q3/{success,success_pago_credito,servicio_digital}` with `documento.xml`, `meta.json`, `requests.json`, and `v2026-Q3/_consulta_page/consulta_page.html`)

The upstream README states these are anonymized captures of the eKuatia consulta-por-CDC, originally ported from another project.

## Authority

The `ekuatia/v2026-Q3/*/requests.json` files are the only authoritative evidence of the eKuatia HTTP contract available to this project (ADR-0022). Do not infer the contract from anywhere else.

## Integrity

`fixtures.manifest.json` maps each fixture path (sorted, relative to this folder) to its sha256. `fixtures.manifest.spec.ts` fails if a fixture changes, is added without a manifest entry, or is removed. To refresh after a deliberate re-import, regenerate the manifest from the new bytes and update the commit hash above.

Fixtures are excluded from Prettier so they stay byte-identical.
