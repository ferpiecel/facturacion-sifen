'use strict';

// Local override: the root config's `sifen-gateway-framework-free` rule matches
// `from` paths containing `packages/sifen-gateway/src/`, which only appear when
// dependency-cruiser is invoked from the monorepo root. Invoked from this
// package's own directory, module sources are relative to `src/` instead, so
// this local config extends the root rules and adds an equivalent rule scoped
// to that local path shape.
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
