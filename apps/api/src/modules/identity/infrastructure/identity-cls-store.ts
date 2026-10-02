import type { ClsStore } from 'nestjs-cls';

/** CLS key carrying the authenticated api key's scopes through a request. */
export const API_KEY_SCOPES_CLS_KEY = 'apiKeyScopes' as const;

/** CLS key carrying the authenticated api key's id (audit actor). */
export const API_KEY_ID_CLS_KEY = 'apiKeyId' as const;

/** Typed CLS store for this module: extends the base store with `apiKeyScopes` and `apiKeyId`. */
export interface IdentityClsStore extends ClsStore {
  [API_KEY_SCOPES_CLS_KEY]: string[];
  [API_KEY_ID_CLS_KEY]: string;
}
