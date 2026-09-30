import nextPlugin from '@next/eslint-plugin-next';
import sharedConfig from '@sifen/config/eslint.config.js';
import reactHooks from 'eslint-plugin-react-hooks';

// Extends the shared workspace config with React hooks and Next.js rules,
// then points typed linting at `apps/web/tsconfig.json`.
export default [
  {
    ignores: [
      '.next/**',
      'coverage/**',
      'next-env.d.ts',
      'postcss.config.mjs',
      '.dependency-cruiser.cjs',
    ],
  },
  ...sharedConfig,
  reactHooks.configs.flat['recommended-latest'],
  nextPlugin.configs['core-web-vitals'],
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
        projectService: {
          allowDefaultProject: ['eslint.config.js'],
        },
      },
    },
  },
];
