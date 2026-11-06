import type { TenantFiscalRuc } from '../../domain/receiver-match.js';

/** Read-only view of the tenant's own fiscal identity, used to decide who a document is for. */
export interface TenantFiscalIdentity {
  /** RUC base and check digit of the tenant, or null when it has no fiscal profile yet. */
  getRucIdentity(tenantId: string): Promise<TenantFiscalRuc | null>;
}
