import type { Database } from '@sifen/db';
import type { LotePollStore } from '../application/poll-lote-result.js';

export interface DrizzleLotePollStoreOptions {
  readonly db: Database;
  readonly tenantId: string;
}

/** `LotePollStore` over `lotes`, `lote_documents` and `documents`, run as app_user inside the tenant's transaction. */
export function createDrizzleLotePollStore(_options: DrizzleLotePollStoreOptions): LotePollStore {
  return {
    load: () => Promise.reject(new Error('not implemented')),
    record: () => Promise.reject(new Error('not implemented')),
  };
}
