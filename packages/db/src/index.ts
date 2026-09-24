export {
  createNodePostgresDatabase,
  createPgliteDatabase,
  type Database,
  type DatabaseHandle,
} from './client.js';
export { TENANT_TABLES, tenantProbe, tenants } from './schema.js';
export { InvalidTenantIdError } from './errors.js';
export { assertValidTenantId, isValidTenantId } from './tenant-id.js';
export { withTenantTransaction, type TenantTx } from './tenant-transaction.js';
