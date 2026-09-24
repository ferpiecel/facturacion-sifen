import type { ClsStore } from 'nestjs-cls';

/** CLS key carrying the authenticated api key's scopes through a request. */
export const API_KEY_SCOPES_CLS_KEY = 'apiKeyScopes' as const;

/** Typed CLS store for this module: extends the base store with `apiKeyScopes`. */
export interface IdentityClsStore extends ClsStore {
  [API_KEY_SCOPES_CLS_KEY]: string[];
}
