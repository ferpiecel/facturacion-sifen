'use strict';

// `pnpm depcruise` runs from this package directory. Extends the root rules
// (no-circular, TIPS confinement) and keeps dependencies flowing inward:
// app/ (routes) -> features/ (screens) -> design-system/ (reusable UI).
module.exports = {
  extends: '../../.dependency-cruiser.cjs',
  forbidden: [
    {
      name: 'design-system-no-app',
      severity: 'error',
      comment: 'src/design-system/ is reusable UI and must not import features or routes',
      from: { path: '^src/design-system/' },
      to: { path: '^src/(app|features)/' },
    },
    {
      name: 'features-no-app',
      severity: 'error',
      comment: 'src/features/ must not import route code from src/app/',
      from: { path: '^src/features/' },
      to: { path: '^src/app/' },
    },
  ],
};
