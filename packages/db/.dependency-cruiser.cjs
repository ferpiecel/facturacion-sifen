'use strict';

// `pnpm depcruise` runs from this package directory, so module paths are
// relative to it (`src/...`). This config extends the root rules (layering,
// no-circular) and adds the framework-isolation rule for this package.
// @sifen/db is a plain data-access package: it owns `pg` and `drizzle-orm`
// as its allowed persistence dependencies but must never depend on the
// application/worker frameworks that consume it.
const FW = '(^|node_modules/)((@nestjs|@fastify)/|(fastify|bullmq|ioredis|reflect-metadata)(/|$))';

module.exports = {
  extends: '../../.dependency-cruiser.cjs',
  forbidden: [
    {
      name: 'db-framework-free-local',
      severity: 'error',
      comment: '@sifen/db must stay free of application frameworks (local invocation)',
      from: { path: '^src/' },
      to: { path: FW },
    },
  ],
};
