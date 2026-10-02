import type { AuditEntry } from '../../../audit/application/ports/record-audit.port.js';

/** Everything the emitter side of a document needs, resolved server-side for one tenant. */
export interface IssuerContext {
  environment: 'test' | 'production';
  /** dRucEm and dDVEmi from the tenant's fiscal profile. */
  rucBase: string;
  rucDv: number;
  /** iTipCont. */
  taxpayerType: 1 | 2;
  timbradoId: string;
  establishmentId: string;
  expeditionPointId: string;
}

export interface IssuerQuery {
  /** dEst / dPunExp as sent by the integrator. */
  establishmentCode: string;
  expeditionPointCode: string;
  /** Issue date in Paraguay local time, `YYYY-MM-DD`. */
  issueDate: string;
}

export interface NewDocument {
  environment: IssuerContext['environment'];
  cdc: string;
  documentType: number;
  timbradoId: string;
  establishmentId: string;
  expeditionPointId: string;
  /** '' while numbering runs without a series. */
  series: string;
  number: number;
  securityCode: string;
  receiverRuc: string | null;
  issuedAt: Date;
  totalAmount: string;
  currency: string;
  payload: unknown;
}

/** Operations that must share one tenant transaction. */
export interface AcceptanceUnit {
  /** The tenant's issuer setup, or null when the point or a valid timbrado does not exist. */
  resolveIssuer(query: IssuerQuery): Promise<IssuerContext | null>;
  nextNumber(
    issuer: IssuerContext,
    documentType: number,
  ): Promise<{ series: string | null; number: number }>;
  insertDocument(document: NewDocument): Promise<{ id: string }>;
  recordAudit(entry: AuditEntry): Promise<void>;
}

/** Runs `work` in one tenant transaction: it commits or rolls back as a whole (gapless numbering). */
export interface AcceptanceUnitOfWork {
  run<T>(tenantId: string, work: (unit: AcceptanceUnit) => Promise<T>): Promise<T>;
}
