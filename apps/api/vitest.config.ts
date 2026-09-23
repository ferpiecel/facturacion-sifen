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
  },
});
