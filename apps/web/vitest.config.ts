import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    root: import.meta.dirname,
    environment: 'jsdom',
    include: ['src/**/*.spec.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      // Vitest 5 removed `all`: every file matched by `include` is reported,
      // even when no test imports it.
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.spec.{ts,tsx}',
        // Root layout wires next/font/google, which only runs inside the Next
        // compiler; it holds no logic and is exercised by `next build`.
        'src/app/layout.tsx',
        'src/app/fonts.ts',
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
