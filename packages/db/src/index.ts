export {
  createNodePostgresDatabase,
  createPgliteDatabase,
  type Database,
  type DatabaseHandle,
} from './client.js';
export {
  apiKeyEnvironment,
  apiKeys,
  fiscalTaxpayerType,
  partners,
  TENANT_TABLES,
  tenantDocumentSequences,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenantFiscalEconomicActivities,
  tenantFiscalProfiles,
  tenantProbe,
  tenants,
  tenantTimbrados,
} from './schema.js';
export { InvalidTenantIdError, PrivilegedSessionError } from './errors.js';
export { assertValidTenantId, isValidTenantId } from './tenant-id.js';
export { withTenantTransaction, type TenantTx } from './tenant-transaction.js';
export { withAppRoleTransaction, type AppRoleTx } from './app-role-transaction.js';
export { assertNonPrivilegedSession } from './session-guard.js';
export { TenantAwareProcessor, type TenantJob } from './tenant-aware-processor.js';
export * from './document-number.js';
