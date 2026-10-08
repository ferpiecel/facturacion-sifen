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
