/**
 * Thrown by {@link import('./tenant-transaction-runner.js').TenantTransactionRunner}
 * when it runs outside a request/job that set a tenant id on the CLS
 * context — i.e. the tenant guard (or processor) never ran for this call.
 */
export class MissingTenantContextError extends Error {
  constructor() {
    super(
      'No tenant id set on the CLS context: the tenant guard did not run before this call.',
    );
    this.name = 'MissingTenantContextError';
  }
}
