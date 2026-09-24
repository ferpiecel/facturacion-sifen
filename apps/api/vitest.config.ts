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
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.ts'],
      exclude: [
        '**/*.spec.ts',
        // Process bootstrap entrypoint: top-level await wiring Nest/Fastify,
        // exercised by e2e/manual runs rather than unit tests.
        'src/main.ts',
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
