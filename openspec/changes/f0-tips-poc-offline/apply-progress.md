# Apply progress: f0-tips-poc-offline

## Session: Phases 3-4 (package scaffold + adapters with unit tests)

Branch: `feat/hu-e0-04-sifen-tips-adapters`. Scope: Phase 3 (`@sifen/sifen-tips`
package scaffold) and Phase 4 (adapters, TDD RED→GREEN). Phases 5-6 (e2e PoC,
no-subprocess guard, dev certificate) are out of scope for this session.

### Completed

- Phase 3 (3.1-3.4): package scaffold mirroring `@sifen/sifen-xsd`, package-local
  `.dependency-cruiser.cjs` fixing the root rule's package-local-run blind spot
  (review item a), TIPS lib typings read from `node_modules` after install.
- Phase 4 (4.1-4.7): `TipsDeXmlBuilder`, `TipsXmlSigner`, `TipsQrGenerator`,
  each with a RED commit (module-not-found) then a GREEN commit, plus
  `src/index.ts` re-exporting all three.
- Review item (b): `TipsXmlSigner` writes the p12 to an ephemeral
  `fs.mkdtemp(os.tmpdir())` file, mode 0600, always removed in `finally`;
  tested for both success and failure paths, plus a `child_process.spawn`/`exec`
  spy asserting zero calls. `signByNodeJS: true` is hard-coded, never conditional.

### Required fixes beyond the literal task text

1. `packages/sifen-gateway/tsconfig.build.json` — added `declaration: true`.
   The shared base config sets `declaration: false`; `@sifen/sifen-tips` is the
   first real cross-package consumer of `@sifen/sifen-gateway`'s types, and
   without declarations, typecheck failed with TS7016 (no `.d.ts` in `dist`).
2. `packages/sifen-tips/eslint.config.js` — added `test/fixtures/**` to
   `ignores` (same pattern as `sifen-gateway`); otherwise the fixture (not part
   of the tsconfig project) fails typed-lint parsing.
3. CJS interop gotcha (not in design.md): under `moduleResolution: nodenext`,
   a default import of a CJS TIPS library types as (and in real Node, is) the
   whole module object — `xmlgen.default.generateXMLDE`, not
   `xmlgen.generateXMLDE`. Vitest's Vite-based runtime, however, auto-unwraps
   the default export already, so at test time `xmlgen` IS the API directly.
   Added `packages/sifen-tips/src/cjs-interop.ts` (`resolveCjsDefault`) so
   each adapter reads whichever shape is present, keeping tsc and Vitest both
   green without environment-specific branches in each adapter.
4. Prettier line-length fixes to 3 files (caught by `//:format:check`).

### Verification (this session)

- `pnpm --filter @sifen/sifen-tips test` — 4 files, 9 tests, all green.
- `pnpm --filter @sifen/sifen-gateway test` — 6 files, 33 tests, all green
  (unaffected by the `declaration: true` change).
- `npx --yes pnpm@12.5.1 turbo run format:check lint typecheck depcruise test build`
  — 24/24 tasks successful.
- `git diff main...HEAD --shortstat -- . ':(exclude)pnpm-lock.yaml' ':(exclude)openspec'`
  → 17 files changed, 350 insertions(+), 1 deletion(-) — within the 400-line PR budget.

### Deviations from tasks.md literal text

- Test files use `*.spec.ts`, not `*.test.ts` (matches the repo-wide vitest
  include glob `src/**/*.spec.ts` set up in Phase 1 for `sifen-gateway`, and
  this package's own `vitest.config.ts`, which I authored the same way).

### Next steps (not started)

- Phase 5: dev certificate generator (`node-forge`), no-subprocess guard utility.
- Phase 6: offline e2e PoC test (build → sign → QR → XSD validate → FakeSifenGateway).
- Phase 7: final cross-package verification, proposal.md checkbox updates.
