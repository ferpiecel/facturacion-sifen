import type { DocumentStatus } from '../../design-system/components/status-badge';

// Mock data for the documents explorer until `GET /v1/documents` exists (the
// screen shows "Datos de ejemplo"). Shapes mirror the domain so the fixture can
// be swapped for the API response.

export interface PeriodSummary {
  period: string;
  issued: number;
  issuedGrowthPct: number;
  goal: number;
  approved: number;
  approvedPct: number;
  queued: number;
  queueAvgLatencySeconds: number;
  rejected: number;
  errorRatePct: number;
  /** SIFEN codes behind the rejected documents (verified rules only). */
  rejectionCodes: readonly string[];
}

// 1.398 approved + 24 queued + 6 rejected = 1.428 issued.
export const SAMPLE_PERIOD_SUMMARY: PeriodSummary = {
  period: 'Últimos 30 días',
  issued: 1428,
  issuedGrowthPct: 14.2,
  goal: 2000,
  approved: 1398,
  approvedPct: 97.9,
  queued: 24,
  queueAvgLatencySeconds: 1.2,
  rejected: 6,
  errorRatePct: 0.4,
  rejectionCodes: ['1321'],
};

export type DocumentKind = 'FE' | 'NCE' | 'NDE' | 'AFE';

export interface DocumentReceiver {
  kind: 'ruc' | 'ci' | 'unnamed';
  name: string;
  /** RUC with check digit (`80034567-3`) or CI; empty for an unnamed receiver. */
  id: string;
}

export interface DocumentRow {
  documentId: string;
  /** 44-digit CDC: valid SET modulo 11 check digit, issuer RUC 80012345-0. */
  cdc: string;
  kind: DocumentKind;
  status: DocumentStatus;
  /** `establishment-point-number`, as printed on the document. */
  number: string;
  establishment: string;
  /** Issue instant in UTC; shown in America/Asuncion. */
  issuedAt: string;
  timbrado: string;
  receiver: DocumentReceiver;
  /** Positive total in Guaraníes; credit notes are shown negative. */
  total: number;
  associatedNumber?: string;
  note?: string;
  batch?: string;
  latencyMs?: number;
  rejection?: { code: string; message: string };
}

export interface DocumentsPage {
  items: readonly DocumentRow[];
  page: number;
  pageSize: number;
  total: number;
  /** Period counts per type, as the API will return them. */
  countsByKind: Readonly<Record<DocumentKind, number>>;
}

export const ESTABLISHMENTS: Readonly<Record<string, string>> = {
  '001': 'Casa Central Asunción',
  '002': 'Sucursal Ciudad del Este',
};

const TIMBRADO = '12548900';

export const SAMPLE_DOCUMENTS_PAGE: DocumentsPage = {
  page: 1,
  pageSize: 5,
  total: 1428,
  countsByKind: { FE: 1210, NCE: 184, NDE: 0, AFE: 34 },
  items: [
    {
      documentId: 'b1c1f2a0-6a0d-4a57-9f0e-0a1f5d1c2e01',
      cdc: '01800123450001001000452022026100214582139077',
      kind: 'FE',
      status: 'aprobado',
      number: '001-001-0004520',
      establishment: '001',
      issuedAt: '2026-10-02T18:42:00Z',
      timbrado: TIMBRADO,
      receiver: { kind: 'ruc', name: 'TELECOMUNICACIONES DEL SUR S.A.', id: '80034567-3' },
      total: 16_100_000,
      latencyMs: 118,
    },
    {
      documentId: 'b1c1f2a0-6a0d-4a57-9f0e-0a1f5d1c2e02',
      cdc: '01800123450001001000451922026100211274308560',
      kind: 'FE',
      status: 'aprobado',
      number: '001-001-0004519',
      establishment: '001',
      issuedAt: '2026-10-02T17:15:00Z',
      timbrado: TIMBRADO,
      receiver: { kind: 'ruc', name: 'AGROGANADERA DEL ESTE S.R.L.', id: '80099231-8' },
      total: 4_520_000,
      latencyMs: 140,
    },
    {
      documentId: 'b1c1f2a0-6a0d-4a57-9f0e-0a1f5d1c2e03',
      cdc: '05800123450001001000010422026100219305612471',
      kind: 'NCE',
      status: 'aprobado',
      number: '001-001-0000104',
      establishment: '001',
      issuedAt: '2026-10-02T14:20:00Z',
      timbrado: TIMBRADO,
      receiver: { kind: 'ci', name: 'MARTA BEATRIZ BENITEZ', id: '3.456.789' },
      total: 850_000,
      associatedNumber: '001-001-0004490',
      note: 'Devolución parcial de mercadería',
    },
    {
      documentId: 'b1c1f2a0-6a0d-4a57-9f0e-0a1f5d1c2e04',
      cdc: '01800123450002001000118822026100216048713290',
      kind: 'FE',
      status: 'en_lote',
      number: '002-001-0001188',
      establishment: '002',
      issuedAt: '2026-10-02T18:44:00Z',
      timbrado: TIMBRADO,
      receiver: { kind: 'ruc', name: 'DISTRIBUIDORA ITAPÚA S.A.', id: '80011223-7' },
      total: 3_200_000,
      batch: '8921',
      note: 'Esperando respuesta de SIFEN',
    },
    {
      documentId: 'b1c1f2a0-6a0d-4a57-9f0e-0a1f5d1c2e05',
      cdc: '01800123450001001000451822026100213159287646',
      kind: 'FE',
      status: 'rechazado',
      number: '001-001-0004518',
      establishment: '001',
      issuedAt: '2026-10-02T16:50:00Z',
      timbrado: TIMBRADO,
      receiver: { kind: 'unnamed', name: 'Innominado', id: '' },
      total: 8_900_000,
      note: 'Requiere subsanación',
      rejection: {
        code: '1321',
        message: 'Receptor innominado no permitido cuando el total es de ₲ 7.000.000 o más',
      },
    },
  ],
};
