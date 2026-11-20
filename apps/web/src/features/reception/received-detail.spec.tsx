import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReceivedDocumentDetail, ReceptionClient } from './reception-client';
import { ReceivedDetail } from './received-detail';

const { replace, router } = vi.hoisted(() => {
  const replace = vi.fn();
  return { replace, router: { push: vi.fn(), replace } };
});
vi.mock('next/navigation', () => ({ useRouter: () => router }));

beforeEach(() => {
  replace.mockClear();
});

const DOC: ReceivedDocumentDetail = {
  id: 'd1',
  status: 'needs_review',
  source: 'api',
  version: 2,
  needs_review: true,
  is_own_receiver: false,
  document_type: 1,
  cdc: '0'.repeat(44),
  document_number: '001-001-0000123',
  issued_on: '2026-10-02',
  currency: 'PYG',
  confidence_overall: null,
  confirmed_at: null,
  created_at: '2026-10-02T12:00:00Z',
  updated_at: '2026-10-02T12:00:00Z',
  needs_review_reasons: ['low_confidence:total', '<b>raro</b>'],
  extraction_error_code: 'llm_timeout',
  extraction_attempts: 2,
  timbrado: '12345678',
  series: 'AB',
  establishment_code: '001',
  expedition_point_code: '001',
  document_sequence: '0000123',
  exchange_rate: '7300',
  issuer: {
    ruc: '80012345-6',
    ruc_base: '80012345',
    ruc_dv: 6,
    legal_name: '<img src=x onerror=alert(1)>',
    trade_name: null,
    address: null,
    economic_activity: null,
  },
  receiver: { ruc: '1-9', ruc_base: '1', ruc_dv: 9, legal_name: 'Mi Empresa', type: 1 },
  payment: { condition: 1, credit_term_days: null, method: null, due_on: null, paid_on: null },
  totals: {
    exempt: null,
    zero_rated: null,
    taxable_5: null,
    taxable_10: '100000',
    vat_5: null,
    vat_10: '10000',
    total_vat: '10000',
    discount: null,
    total_amount: '110000',
    total_pyg: '110000',
  },
  sifen: { status: null, authorized_at: null, protocol_number: null },
  items: [
    {
      position: 1,
      description: 'Servicio',
      product_code: 'S1',
      quantity: '2',
      unit_of_measure: 'UNI',
      unit_price: '50000',
      discount: null,
      subtotal: '100000',
      vat_rate: 10,
      taxable_base: '100000',
      vat_amount: '10000',
    },
  ],
  field_confidences: [],
  confirmed_by: null,
  corrected_at: null,
  corrected_by: null,
  artifact: {
    id: 'a1',
    content_type: 'application/pdf',
    size_bytes: 1024,
    sha256: 'x',
    original_name: 'factura.pdf',
    page_count: 1,
  },
  artifact_url: '/portal/received-documents/d1/artifact',
};

const clientOf = (detail: ReceptionClient['detail']): ReceptionClient => ({
  list: vi.fn(),
  detail,
  artifactUrl: (id) => `/api/portal/received-documents/${id}/artifact`,
});
const okClient = (doc = DOC) =>
  clientOf(vi.fn(() => Promise.resolve({ kind: 'ok' as const, document: doc })));

describe('ReceivedDetail', () => {
  it('shows a loading state, then status and extracted fields', async () => {
    render(<ReceivedDetail id="d1" client={okClient()} />);

    expect(screen.getByRole('status')).toHaveTextContent('Cargando documento recibido');
    expect(await screen.findByText('001-001-0000123')).toBeVisible();
    expect(screen.getByText('Requiere revisión')).toBeVisible();
    for (const text of ['12345678', 'AB', '7300', 'Mi Empresa', '80012345-6', '110000']) {
      expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    }
  });

  it('flags a document addressed to another receiver, review reasons and the error code, as text', async () => {
    const { container } = render(<ReceivedDetail id="d1" client={okClient()} />);

    expect(await screen.findByText('Otro receptor')).toBeVisible();
    expect(screen.getByText('low_confidence:total')).toBeVisible();
    expect(screen.getByText('<b>raro</b>')).toBeVisible();
    expect(screen.getByText(/llm_timeout/)).toBeVisible();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeVisible();
    expect(container.querySelector('b, img[src="x"]')).toBeNull();
  });

  it('omits the flags of a clean own document', async () => {
    const clean = {
      ...DOC,
      is_own_receiver: true,
      needs_review: false,
      needs_review_reasons: [],
      extraction_error_code: null,
    };
    render(<ReceivedDetail id="d1" client={okClient(clean)} />);

    await screen.findByText('001-001-0000123');
    expect(screen.queryByText('Otro receptor')).toBeNull();
    expect(screen.queryByText(/llm_timeout/)).toBeNull();
  });

  it('lists the items', async () => {
    render(<ReceivedDetail id="d1" client={okClient()} />);

    const table = await screen.findByRole('table', { name: 'Ítems' });
    expect(within(table).getByText('Servicio')).toBeVisible();
    expect(within(table).getByText('50000')).toBeVisible();
  });

  it('links the artifact through the portal route, not the API path of the detail', async () => {
    render(<ReceivedDetail id="d1" client={okClient()} />);

    const link = await screen.findByRole('link', { name: 'Abrir artefacto' });
    expect(link).toHaveAttribute('href', '/api/portal/received-documents/d1/artifact');
    expect(
      document.querySelector(
        '[href*="/portal/received-documents/d1/artifact"]:not([href^="/api"])',
      ),
    ).toBeNull();
  });

  it('has no write controls', async () => {
    render(<ReceivedDetail id="d1" client={okClient()} />);

    await screen.findByText('001-001-0000123');
    expect(screen.queryByRole('button')).toBeNull();
    expect(document.querySelector('form, input, textarea, select')).toBeNull();
    expect(screen.queryByText(/editar|confirmar|guardar/i)).toBeNull();
  });

  it('explains a missing document', async () => {
    render(
      <ReceivedDetail
        id="x"
        client={clientOf(vi.fn(() => Promise.resolve({ kind: 'not_found' as const })))}
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('no existe');
  });

  it('offers a retry when the API is unavailable', async () => {
    const detail = vi
      .fn<ReceptionClient['detail']>()
      .mockResolvedValueOnce({ kind: 'unavailable' })
      .mockResolvedValueOnce({ kind: 'ok', document: DOC });
    render(<ReceivedDetail id="d1" client={clientOf(detail)} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('No pudimos cargar');
    within(alert).getByRole('button', { name: 'Reintentar' }).click();
    expect(await screen.findByText('001-001-0000123')).toBeVisible();
  });

  it('sends the user back to the login when the session is gone', async () => {
    render(
      <ReceivedDetail
        id="d1"
        client={clientOf(vi.fn(() => Promise.resolve({ kind: 'unauthenticated' as const })))}
      />,
    );

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/login');
    });
  });
});
