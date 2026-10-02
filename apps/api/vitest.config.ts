import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    // Preserves TypeScript decorator metadata so Nest's dependency injection
    // resolves correctly under the Vitest test runner.
    swc.vite({
      module: { type: 'es6' },
    }),
  ],
  test: {
    root: import.meta.dirname,
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    // Tenancy integration specs boot PGlite and apply every migration; CI
    // runners need more than the 5 s default as migrations accumulate.
    // Each worker holds several WASM Postgres instances and is CPU-bound;
    // one worker per core under `turbo` parallelism caused OOM-killed
    // workers (SIGKILL) and "connection terminated unexpectedly".
    maxWorkers: 4,
    // The process timezone must never leak into fiscal timestamps (xmlgen formats
    // dates with local getters): run the whole suite under UTC, where any leak shows.
    env: { TZ: 'UTC' },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.ts'],
      exclude: [
        '**/*.spec.ts',
        // Process bootstrap entrypoint: top-level await wiring Nest/Fastify,
        // exercised by e2e/manual runs rather than unit tests.
        'src/main.ts',
        // Operator CLI process entrypoint (argv/env wiring, prints,
        // process.exit): exercised by the manual docker check, not unit
        // tests. Its argv parsing (args.ts) and dispatch (ops.ts's
        // exported runOpsCommand) are unit-tested directly.
        'src/cli/ops.ts',
        // Type-only declaration output, nothing to execute.
        '**/*.d.ts',
      ],
      thresholds: {
        lines: 85,
        branches: 85,
        functions: 85,
        statements: 85,
      },
    },
  },
});
