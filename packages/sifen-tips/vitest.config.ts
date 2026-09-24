import { defineConfig } from 'vitest/config';

const E2E_INCLUDE = ['test/poc-offline.e2e.spec.ts'];

export default defineConfig({
  test: {
    root: import.meta.dirname,
    projects: [
      {
        test: {
          name: 'unit',
          root: import.meta.dirname,
          include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
          exclude: E2E_INCLUDE,
        },
      },
      {
        test: {
          // Dedicated project so the no-subprocess guard's setupFiles entry
          // runs before this project's test files load (see
          // test/support/install-no-subprocess-guard-setup.ts).
          name: 'e2e',
          root: import.meta.dirname,
          include: E2E_INCLUDE,
          setupFiles: ['./test/support/install-no-subprocess-guard-setup.ts'],
        },
      },
    ],
  },
});
