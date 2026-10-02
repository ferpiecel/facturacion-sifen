import type { Database } from '@sifen/db';
import type { LoteAssemblyStore } from '../application/assemble-lotes.js';

export interface DrizzleLoteAssemblyStoreOptions {
  readonly db: Database;
  readonly tenantId: string;
  /** Most documents read per assembly run; the rest wait for the next one. */
  readonly batchSize?: number;
}

/** `LoteAssemblyStore` over `documents`, `lotes` and `lote_documents`, run as app_user inside the tenant's transaction. */
export function createDrizzleLoteAssemblyStore(
  _options: DrizzleLoteAssemblyStoreOptions,
): LoteAssemblyStore {
  return {
    readyDocuments: () => Promise.reject(new Error('not implemented')),
    cdcsInProcess: () => Promise.reject(new Error('not implemented')),
    createLote: () => Promise.reject(new Error('not implemented')),
  };
}
