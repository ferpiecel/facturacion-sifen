<<<<<<< HEAD
import type { DocumentStatus } from '../../design-system/components/status-badge';

// Sample data shown on the panel until the API is wired (labeled "Datos de
// ejemplo" in the UI). CDCs follow the SIFEN layout with the issuer's RUC
// (80012345-0) and a valid check digit; types use the official iTiDE codes
// (01 FE, 04 AFE, 05 NCE).

export type DocumentType = 'FE' | 'NC' | 'AF';

export interface RecentDocument {
  type: DocumentType;
  number: string;
  receiver: string;
  receiverId: string;
  cdc: string;
  amount: number;
  status: DocumentStatus;
}

export const SAMPLE_TENANT = 'Acme Paraguay S.A.';

export const SAMPLE_BILLING_TODAY = 48_750_000;

export const SAMPLE_USER = { name: 'Carlos Bogado', role: 'Operador Certificado' } as const;

export const SAMPLE_RECENT_DOCUMENTS: readonly RecentDocument[] = [
  {
    type: 'FE',
    number: '001-001-0004812',
    receiver: 'Itaú Paraguay S.A.',
    receiverId: 'RUC: 80003214-5',
    cdc: '01800123450001001000481222026092911789423585',
    amount: 12_850_000,
    status: 'aprobado',
  },
  {
    type: 'FE',
    number: '001-001-0004811',
    receiver: 'Retail S.A. (Superseis)',
    receiverId: 'RUC: 80021487-1',
    cdc: '01800123450001001000481122026092911789423593',
    amount: 3_420_000,
    status: 'aprobado',
  },
  {
    type: 'NC',
    number: '001-001-0000319',
    receiver: 'Agropecuaria del Este S.R.L.',
    receiverId: 'RUC: 80099412-9',
    cdc: '05800123450001001000031922026092911789423604',
    amount: -650_000,
    status: 'aprobado',
  },
  {
    type: 'FE',
    number: '001-002-0001005',
    receiver: 'Marta Elena Benítez',
    receiverId: 'CI: 4.120.985',
    cdc: '01800123450001002000100522026092911789423612',
    amount: 780_000,
    status: 'aprobado',
  },
  {
    type: 'AF',
    number: '001-001-0000084',
    receiver: 'Cooperativa Chortitzer Ltda.',
    receiverId: 'RUC: 80000109-6',
    cdc: '04800123450001001000008422026092911789423629',
    amount: 31_350_000,
    status: 'aprobado',
  },
];
=======
// Sample data shown on the panel until the API is wired (labeled "Datos de
// ejemplo" in the UI).

export const SAMPLE_TENANT = 'Acme Paraguay S.A.';

export const SAMPLE_USER = { name: 'Carlos Bogado', role: 'Operador Certificado' } as const;
>>>>>>> origin/main
