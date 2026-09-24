export {
  createNodePostgresDatabase,
  createPgliteDatabase,
  type Database,
  type DatabaseHandle,
} from './client.js';
export { apiKeyEnvironment, apiKeys, TENANT_TABLES, tenantProbe, tenants } from './schema.js';
export { InvalidTenantIdError, PrivilegedSessionError } from './errors.js';
export { assertValidTenantId, isValidTenantId } from './tenant-id.js';
export { withTenantTransaction, type TenantTx } from './tenant-transaction.js';
export { withAppRoleTransaction, type AppRoleTx } from './app-role-transaction.js';
export { assertNonPrivilegedSession } from './session-guard.js';
export { TenantAwareProcessor, type TenantJob } from './tenant-aware-processor.js';
