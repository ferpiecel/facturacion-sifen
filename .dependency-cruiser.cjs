'use strict';

// Matches @nestjs/*, @fastify/*, and framework packages used across layers,
// both as resolved pnpm paths and as unresolved bare names (test fixtures).
const FW =
  '(^|node_modules/)((@nestjs|@fastify)/|(fastify|drizzle-orm|bullmq|ioredis|pg|reflect-metadata)(/|$))';

module.exports = {
  options: {
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' },
  },
  forbidden: [
    {
      name: 'domain-app-framework-free',
      severity: 'error',
      comment: 'domain/ and application/ must stay framework-free (ADR-0003)',
      from: { path: '(^|/)modules/[^/]+/(domain|application)/' },
      to: { path: FW },
    },
    {
      name: 'domain-no-outer-layers',
      severity: 'error',
      comment: 'domain/ must not import application/ or infrastructure/',
      from: { path: '(^|/)modules/[^/]+/domain/' },
      to: { path: '(^|/)modules/[^/]+/(application|infrastructure)/' },
    },
    {
      name: 'application-no-infrastructure',
      severity: 'error',
      comment: 'application/ must not import infrastructure/',
      from: { path: '(^|/)modules/[^/]+/application/' },
      to: { path: '(^|/)modules/[^/]+/infrastructure/' },
    },
    {
      name: 'sifen-gateway-framework-free',
      severity: 'error',
      comment: '@sifen/sifen-gateway must stay framework-free',
      from: { path: '(^|/)packages/sifen-gateway/src/' },
      to: { path: FW },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'no circular imports anywhere in the workspace',
      from: {},
      to: { circular: true },
    },
  ],
};
