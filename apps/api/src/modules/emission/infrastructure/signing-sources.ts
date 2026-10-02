import { and, asc, eq } from 'drizzle-orm';
import { tenantCscs, withTenantTransaction, type Database } from '@sifen/db';
import type { CertificateSource, CscSource } from '../application/ports/signing.port.js';

/** Minimal view of `CertificateVault` the signing flow needs. */
export interface CertificateOpener {
  open(
    db: Database,
    tenantId: string,
    environment: 'test' | 'production',
  ): Promise<{ p12: Buffer; password: string }>;
}

/** Minimal view of `CscVault` the signing flow needs. */
export interface CscOpener {
  getPlaintext(
    db: Database,
    tenantId: string,
    environment: 'test' | 'production',
    idCsc: string,
  ): Promise<Buffer>;
}

/** `CertificateSource` over the certificate vault: the tenant's active certificate, in memory only. */
export function createCertificateSource({
  db,
  vault,
}: {
  db: Database;
  vault: CertificateOpener;
}): CertificateSource {
  return { open: (tenantId, environment) => vault.open(db, tenantId, environment) };
}

/**
 * `CscSource` over the CSC vault. A tenant may hold two CSCs per environment (slots 1 and 2); the
 * lowest slot is used until a rotation policy says otherwise.
 */
export function createCscSource({ db, vault }: { db: Database; vault: CscOpener }): CscSource {
  return {
    async get(tenantId, environment) {
      const rows = await withTenantTransaction(db, tenantId, (tx) =>
        tx
          .select({ idCsc: tenantCscs.idCsc })
          .from(tenantCscs)
          .where(and(eq(tenantCscs.tenantId, tenantId), eq(tenantCscs.environment, environment)))
          .orderBy(asc(tenantCscs.slot))
          .limit(1),
      );
      const row = rows.at(0);
      if (!row) return null;
      const value = await vault.getPlaintext(db, tenantId, environment, row.idCsc);
      return { idCsc: row.idCsc, value };
    },
  };
}
