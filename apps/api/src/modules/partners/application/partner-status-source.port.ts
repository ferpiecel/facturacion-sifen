export interface PartnerTenantRow {
  id: string;
  name: string;
  environment: string;
}

export interface PartnerCertificateRow {
  tenantId: string;
  environment: string;
  status: string;
  notAfter: Date;
}

export interface PartnerDocumentCountRow {
  tenantId: string;
  status: string;
  total: number;
}

/** Raw operational rows of one partner; by construction they carry no document content. */
export interface PartnerStatusSnapshot {
  tenants: PartnerTenantRow[];
  certificates: PartnerCertificateRow[];
  documentCounts: PartnerDocumentCountRow[];
}

export interface PartnerStatusSource {
  isMember(userId: string, partnerId: string): Promise<boolean>;
  read(partnerId: string): Promise<PartnerStatusSnapshot>;
}
