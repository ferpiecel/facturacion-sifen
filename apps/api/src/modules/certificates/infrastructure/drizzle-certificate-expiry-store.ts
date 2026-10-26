import { and, eq } from 'drizzle-orm';
import { tenantCertificates, tenants, withTenantTransaction, type Database } from '@sifen/db';
import { enqueueCertificateExpiry } from '../../webhooks/infrastructure/enqueue-certificate-expiry.js';
import type { CertificateExpiryStore } from '../application/ports/certificate-expiry-store.port.js';

export interface DrizzleCertificateExpiryStoreOptions {
  readonly db: Database;
  readonly tenantId: string;
}

/**
 * `CertificateExpiryStore` over `tenant_certificates` and the webhook outbox, as app_user in the
 * tenant's transaction. Only public facts are selected: the sealed blob is never read.
 */
export function createDrizzleCertificateExpiryStore({
  db,
  tenantId,
}: DrizzleCertificateExpiryStoreOptions): CertificateExpiryStore {
  return {
    findActive() {
      return withTenantTransaction(db, tenantId, (tx) =>
        tx
          .select({
            id: tenantCertificates.id,
            environment: tenantCertificates.environment,
            fingerprint: tenantCertificates.fingerprint,
            notAfter: tenantCertificates.notAfter,
          })
          .from(tenantCertificates)
          .innerJoin(
            tenants,
            and(
              eq(tenants.id, tenantCertificates.tenantId),
              eq(tenants.environment, tenantCertificates.environment),
            ),
          )
          .where(
            and(eq(tenantCertificates.tenantId, tenantId), eq(tenantCertificates.status, 'active')),
          ),
      );
    },
    enqueue(alerts, at) {
      return withTenantTransaction(db, tenantId, (tx) =>
        enqueueCertificateExpiry(tx, { tenantId, alerts, at }),
      );
    },
  };
}
