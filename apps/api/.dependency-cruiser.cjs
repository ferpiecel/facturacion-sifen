'use strict';

// `pnpm depcruise` runs from this package directory. Extends the root
// rules (layering, no-circular) and adds the persistence-isolation rule:
// @sifen/db (and the persistence deps it re-exports) may only be reached
// from a module's infrastructure/ layer, from *.module.ts wiring, or from
// the operator CLI composition root (`cli/`, HU-E1-05), never from
// domain/, application/, or a controller.
const DB_DEPS = '(^|node_modules/)(@sifen/db(/|$)|@electric-sql/pglite(/|$)|(drizzle-orm|pg)(/|$))';

module.exports = {
  extends: '../../.dependency-cruiser.cjs',
  forbidden: [
    {
      name: 'db-confined-to-infrastructure-and-module-wiring',
      severity: 'error',
      comment:
        '@sifen/db must only be imported from modules/*/infrastructure/, *.module.ts, or cli/ (architecture-boundaries spec)',
      from: {
        path: '^src/',
        pathNot: '((^|/)modules/[^/]+/infrastructure/|(^|/)[^/]+\\.module\\.ts$|(^|/)cli/)',
      },
      to: { path: DB_DEPS },
    },
  ],
};
