import type { Database } from '@sifen/db';
import type { SigningStore } from '../application/ports/signing.port.js';

export interface DrizzleSigningStoreOptions {
  readonly db: Database;
  readonly now?: () => Date;
}

/** `SigningStore` over `documents` and the tenant's fiscal configuration, as app_user under RLS. */
export function createDrizzleSigningStore(_options: DrizzleSigningStoreOptions): SigningStore {
  return {
    load: () => Promise.reject(new Error('not implemented')),
    markSigned: () => Promise.reject(new Error('not implemented')),
  };
}
