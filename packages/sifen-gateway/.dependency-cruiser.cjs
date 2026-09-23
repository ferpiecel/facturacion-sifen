'use strict';

// `pnpm depcruise` runs from this package directory, so module paths are
// relative to it (`src/...`). This config extends the root rules (layering,
// no-circular) and adds the framework-isolation rule for this package.
// test/boundaries.spec.ts proves the rule fires.
const FW =
  '(^|node_modules/)((@nestjs|@fastify)/|(fastify|drizzle-orm|bullmq|ioredis|pg|reflect-metadata)(/|$))';

module.exports = {
  extends: '../../.dependency-cruiser.cjs',
  forbidden: [
    {
      name: 'sifen-gateway-framework-free-local',
      severity: 'error',
      comment: '@sifen/sifen-gateway must stay framework-free (local invocation)',
      from: { path: '^src/' },
      to: { path: FW },
    },
  ],
};
