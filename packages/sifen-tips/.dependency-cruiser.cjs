'use strict';

// `pnpm depcruise` runs from this package directory, so module paths are
// relative to it (`src/...`). The root `tips-libs-confined-to-sifen-tips`
// rule excludes `from` paths containing `packages/sifen-tips/`, which never
// matches a package-local run's relative `src/...` paths — so without this
// override the rule would wrongly flag this package's own adapters for
// importing the TIPS libraries they exist to wrap. This package is the
// confined home for those libraries (ADR-0015), so the rule is ignored here.
// test/boundaries.spec.ts proves depcruise still passes for this package's
// own src and still flags a fixture elsewhere under the root rule. `from`/`to`
// are repeated (not just `severity`) because the test requires this file
// directly with `require()` to get the config `pnpm depcruise` actually uses,
// which does not run dependency-cruiser's own extends-merging.
module.exports = {
  extends: '../../.dependency-cruiser.cjs',
  forbidden: [
    {
      name: 'tips-libs-confined-to-sifen-tips',
      severity: 'ignore',
      comment: 'this package is the confined home for the TIPS libraries (ADR-0015)',
      from: { pathNot: '(^|/)packages/sifen-tips/' },
      to: { path: '(^|node_modules/)facturacionelectronicapy-' },
    },
  ],
};
