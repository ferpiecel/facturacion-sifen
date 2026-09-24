import sharedConfig from '@sifen/config/eslint.config.js';

// Extends the shared workspace config, then overrides `tsconfigRootDir` so
// typed linting resolves `packages/sifen-tips/tsconfig.json` instead of `packages/config`.
export default [
  { ignores: ['dist/**', '.dependency-cruiser.cjs', 'test/fixtures/**'] },
  ...sharedConfig,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
        projectService: {
          allowDefaultProject: ['eslint.config.js', 'vitest.config.ts'],
        },
      },
    },
  },
];
