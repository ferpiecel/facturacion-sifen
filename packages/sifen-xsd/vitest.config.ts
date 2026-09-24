import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      all: true,
      // The gate covers published package code (src/**). scripts/** are
      // maintainer-run CLI tools (XSD refresh/checksum verification), not
      // domain/application code shipped to consumers.
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
