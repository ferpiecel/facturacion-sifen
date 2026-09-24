import type { ApiKeyEnvironment } from '../../domain/api-key.js';

export interface ResolvedApiKeyRecord {
  id: string;
  tenantId: string;
  secretHash: string;
  scopes: string[];
  environment: ApiKeyEnvironment;
}

/** Pre-tenant-context lookup: resolves an active (non-revoked) key by its public `keyId`. */
export interface ApiKeyLookup {
  resolveByKeyId(keyId: string): Promise<ResolvedApiKeyRecord | null>;
  /** Best-effort: implementations must never let this reject the caller. */
  touchLastUsed(id: string): Promise<void>;
}
