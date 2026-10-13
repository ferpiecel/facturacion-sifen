import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** DI token: whether `/docs` is served. Resolved once at startup from the process environment. */
export const API_DOCS_ENABLED = Symbol('API_DOCS_ENABLED');

/**
 * `/docs` is served when `NODE_ENV` is exactly `development` or `test`, or when `API_DOCS_ENABLED=true`
 * (staging). Anything else, including an unset `NODE_ENV`, keeps it off: fail closed.
 */
export function isApiDocsEnabled(env: NodeJS.ProcessEnv): boolean {
  return (
    env.NODE_ENV === 'development' || env.NODE_ENV === 'test' || env.API_DOCS_ENABLED === 'true'
  );
}

/** Docs folder served under `/docs/guides`: `API_DOCS_GUIDES_DIR`, else `docs/` at the workspace root. */
export function resolveGuidesRoot(env: NodeJS.ProcessEnv, cwd: string): string | undefined {
  if (env.API_DOCS_GUIDES_DIR) return resolve(cwd, env.API_DOCS_GUIDES_DIR);
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return join(dir, 'docs');
    if (dirname(dir) === dir) return undefined;
  }
}

/** DI token: the `GuideBrowser` behind `/docs/guides`. */
export const GUIDE_BROWSER = Symbol('GUIDE_BROWSER');
