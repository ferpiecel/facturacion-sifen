import config from './packages/config/prettier.config.js';

// The repo root is the sole entry Prettier resolves; this re-exports the
// shared config from `@sifen/config` so there is one source of truth.
export default config;
