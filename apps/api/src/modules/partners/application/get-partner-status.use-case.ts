import type { PartnerCertificateRow, PartnerStatusSource } from './partner-status-source.port.js';

export interface TenantOperationalStatus {
  tenantId: string;
  name: string;
  environment: string;
  certificate: { status: string; expiresAt: string } | null;
  documentsByStatus: Record<string, number>;
}

/** The certificate that matters for a tenant: its environment's active one, else the latest to expire. */
function pickCertificate(
  certificates: PartnerCertificateRow[],
  environment: string,
): PartnerCertificateRow | undefined {
  const own = certificates.filter((c) => c.environment === environment);
  const byExpiry = (a: PartnerCertificateRow, b: PartnerCertificateRow) =>
    b.notAfter.getTime() - a.notAfter.getTime();
  return own.filter((c) => c.status === 'active').sort(byExpiry)[0] ?? own.sort(byExpiry)[0];
}

/**
 * HU-E1-06: operational status of a partner's tenants (name, environment, certificate, document counts by
 * status). Returns `null` when the user does not belong to the partner (indistinguishable from an unknown
 * partner), without reading anything.
 */
export class GetPartnerStatusUseCase {
  constructor(private readonly source: PartnerStatusSource) {}

  async execute(userId: string, partnerId: string): Promise<TenantOperationalStatus[] | null> {
    if (!(await this.source.isMember(userId, partnerId))) return null;
    const { tenants, certificates, documentCounts } = await this.source.read(partnerId);

    return tenants.map((tenant) => {
      const certificate = pickCertificate(
        certificates.filter((c) => c.tenantId === tenant.id),
        tenant.environment,
      );
      const documentsByStatus: Record<string, number> = {};
      for (const row of documentCounts) {
        if (row.tenantId === tenant.id) documentsByStatus[row.status] = row.total;
      }
      return {
        tenantId: tenant.id,
        name: tenant.name,
        environment: tenant.environment,
        certificate: certificate
          ? { status: certificate.status, expiresAt: certificate.notAfter.toISOString() }
          : null,
        documentsByStatus,
      };
    });
  }
}
