import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    globalSetup: ['test/support/global-setup.ts'],
    // Each spec boots PGlite (or Postgres) and applies every migration; CI
    // runners need more than the 5 s default as migrations accumulate.
    // Each worker holds several WASM Postgres instances (~100 MB each) and is
    // CPU-bound; one worker per core under `turbo` parallelism oversubscribed
    // the machine, causing 30 s timeouts and OOM-killed workers (SIGKILL).
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.ts'],
      exclude: [
        '**/*.spec.ts',
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
