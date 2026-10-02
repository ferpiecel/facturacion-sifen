export {
  createNodePostgresDatabase,
  createPgliteDatabase,
  type Database,
  type DatabaseHandle,
} from './client.js';
export {
  apiKeyEnvironment,
  apiKeys,
  auditActorType,
  auditLog,
  DOCUMENT_STATUSES,
  documents,
  fiscalTaxpayerType,
  LOTE_STATUSES,
  loteDocuments,
  lotes,
  partners,
  TENANT_TABLES,
  tenantDocumentSequences,
  tenantEnvironment,
  tenantEstablishments,
  tenantExpeditionPoints,
  tenantFiscalEconomicActivities,
  tenantFiscalProfiles,
  tenantProbe,
  tenantCertificates,
  tenantCscs,
  tenantRequestSequences,
  tenants,
  tenantTimbrados,
  WEBHOOK_EVENT_TYPES,
  webhookEndpoints,
} from './schema.js';
export {
  InvalidTenantIdError,
  MissingTenantContextError,
  PrivilegedSessionError,
} from './errors.js';
export { assertValidTenantId, isValidTenantId } from './tenant-id.js';
export { withTenantTransaction, type TenantTx } from './tenant-transaction.js';
export { withAppRoleTransaction, type AppRoleTx } from './app-role-transaction.js';
export { assertNonPrivilegedSession } from './session-guard.js';
export { TenantAwareProcessor, type TenantJob } from './tenant-aware-processor.js';
export * from './document-number.js';
export {
  verifyAuditChain,
  type AuditChainBreak,
  type AuditChainCheckpoint,
  type AuditChainResult,
  type VerifyAuditChainOptions,
} from './audit-chain.js';
export * from './series.js';
export * from './request-id.js';
