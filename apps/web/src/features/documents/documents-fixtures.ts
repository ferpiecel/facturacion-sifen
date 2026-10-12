import { vi } from 'vitest';

import type {
  DocumentDetail,
  DocumentItem,
  DocumentsClient,
  DocumentsPage,
} from './documents-client';

/** Test doubles for the documents explorer: contract-shaped data and a fake client. */
export const ITEM: DocumentItem = {
  id: 'b1c1f2a0-6a0d-4a57-9f0e-0a1f5d1c2e01',
  cdc: '01800123450001001000452022026100214582139077',
  type: 'FE',
  number: '001-001-0004520',
  issuedAt: '2026-10-02T18:42:00Z',
  receiverName: 'TELECOMUNICACIONES DEL SUR S.A.',
  receiverRuc: '80034567-3',
  total: '16100000',
  currency: 'PYG',
  status: 'aprobado',
  hasObservations: false,
};

export const DETAIL: DocumentDetail = {
  ...ITEM,
  environment: 'test',
  rejectionReason: null,
  events: [
    { status: 'firmado', at: '2026-10-02T18:42:01Z', code: null, message: null },
    {
      status: 'aprobado',
      at: '2026-10-02T18:42:04Z',
      code: '0260',
      message: 'Autorización del DE satisfactoria',
    },
  ],
};

export const PAGE: DocumentsPage = { items: [ITEM], page: 1, pageSize: 20, total: 1 };

/** A client whose every call is a spy answering the happy path unless overridden. */
export function fakeDocumentsClient(overrides: Partial<DocumentsClient> = {}) {
  return {
    list: vi.fn(() => Promise.resolve({ kind: 'ok' as const, page: PAGE })),
    detail: vi.fn(() => Promise.resolve({ kind: 'ok' as const, document: DETAIL })),
    xml: vi.fn(() => Promise.resolve({ kind: 'ok' as const, xml: '<rDE><DE Id="1"/></rDE>' })),
    kude: vi.fn(() =>
      Promise.resolve({
        kind: 'ok' as const,
        pdf: new Blob(['%PDF'], { type: 'application/pdf' }),
      }),
    ),
    xmlUrl: (id: string) => `/api/portal/documents/${id}/xml`,
    kudeUrl: (id: string) => `/api/portal/documents/${id}/kude`,
    ...overrides,
  } satisfies DocumentsClient;
}
