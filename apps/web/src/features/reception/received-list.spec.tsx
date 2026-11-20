import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ReceivedDocumentSummary,
  ReceivedDocumentsPage,
  ReceptionClient,
} from './reception-client';
import { ReceivedList } from './received-list';

const { replace, router } = vi.hoisted(() => {
  const replace = vi.fn();
  return { replace, router: { push: vi.fn(), replace } };
});
vi.mock('next/navigation', () => ({ useRouter: () => router }));

beforeEach(() => {
  replace.mockClear();
});

const DOC: ReceivedDocumentSummary = {
  id: 'd1',
  status: 'confirmed',
  source: 'api',
  version: 1,
  needs_review: false,
  is_own_receiver: true,
  document_type: 1,
  cdc: null,
  issuer: { ruc: '80012345-6', name: 'Proveedor SA' },
  document_number: '001-001-0000123',
  issued_on: '2026-10-02',
  currency: 'PYG',
  total_amount: '110000',
  total_vat: '10000',
  confidence_overall: null,
  confirmed_at: null,
  has_artifact: true,
  created_at: '2026-10-02T12:00:00Z',
  updated_at: '2026-10-02T12:00:00Z',
};
const OTHER: ReceivedDocumentSummary = {
  ...DOC,
  id: 'd2',
  status: 'needs_review',
  is_own_receiver: false,
  document_number: null,
  issuer: { ruc: null, name: null },
  issued_on: null,
  total_amount: null,
};
const PAGE: ReceivedDocumentsPage = { items: [DOC, OTHER], next_cursor: null };

function fakeClient(
  list: ReceptionClient['list'] = vi.fn(() => Promise.resolve({ kind: 'ok' as const, page: PAGE })),
) {
  return { list, detail: vi.fn(), artifactUrl: vi.fn() } satisfies ReceptionClient;
}

describe('ReceivedList', () => {
  it('shows a loading state, then one row per document without any link', async () => {
    const client = fakeClient();
    render(<ReceivedList client={client} />);

    expect(screen.getByRole('status', { name: 'Cargando documentos recibidos' })).toBeVisible();
    const list = await screen.findByRole('list', { name: 'Documentos recibidos' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(list).queryByRole('link')).toBeNull();
    expect(within(rows[0]).getByText('Proveedor SA')).toBeVisible();
    expect(within(rows[0]).getByText('001-001-0000123')).toBeVisible();
    expect(within(rows[0]).getByText('02/10/2026')).toBeVisible();
    expect(within(rows[0]).getByText('110000 PYG')).toBeVisible();
    expect(within(rows[0]).getByText('Confirmado')).toBeVisible();
    expect(within(rows[1]).getByText('Requiere revisión')).toBeVisible();
    expect(client.list).toHaveBeenCalledWith({ limit: 20 });
  });

  it('flags documents addressed to another receiver and only those', async () => {
    render(<ReceivedList client={fakeClient()} />);

    const rows = within(await screen.findByRole('list')).getAllByRole('listitem');
    expect(within(rows[1]).getByText('Otro receptor')).toBeVisible();
    expect(within(rows[0]).queryByText('Otro receptor')).toBeNull();
  });

  it('filters by status and restarts from the first page', async () => {
    const user = userEvent.setup();
    const list = vi.fn(() => Promise.resolve({ kind: 'ok' as const, page: PAGE }));
    render(<ReceivedList client={fakeClient(list)} />);
    await screen.findByRole('list');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Estado' }), 'needs_review');

    await waitFor(() => {
      expect(list).toHaveBeenLastCalledWith({ status: 'needs_review', limit: 20 });
    });
  });

  it('pages forward and back with the cursor', async () => {
    const user = userEvent.setup();
    const list = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'ok', page: { items: [DOC], next_cursor: 'c2' } })
      .mockResolvedValueOnce({ kind: 'ok', page: { items: [OTHER], next_cursor: null } })
      .mockResolvedValue({ kind: 'ok', page: { items: [DOC], next_cursor: 'c2' } });
    render(<ReceivedList client={fakeClient(list)} />);
    await screen.findByRole('list');
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Siguiente' }));
    const next = await screen.findByRole('list', { name: 'Documentos recibidos' });
    expect(await within(next).findByText('Requiere revisión')).toBeVisible();
    expect(list).toHaveBeenLastCalledWith({ cursor: 'c2', limit: 20 });
    expect(screen.getByRole('button', { name: 'Siguiente' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Anterior' }));
    expect(await within(await screen.findByRole('list')).findByText('Confirmado')).toBeVisible();
    expect(list).toHaveBeenLastCalledWith({ limit: 20 });
  });

  it('explains an empty result', async () => {
    const list = vi.fn(() =>
      Promise.resolve({ kind: 'ok' as const, page: { items: [], next_cursor: null } }),
    );
    render(<ReceivedList client={fakeClient(list)} />);

    expect(await screen.findByText('No hay documentos recibidos para mostrar.')).toBeVisible();
  });

  it('shows an error with a retry', async () => {
    const user = userEvent.setup();
    const list = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'unavailable' })
      .mockResolvedValue({ kind: 'ok', page: PAGE });
    render(<ReceivedList client={fakeClient(list)} />);

    expect(await screen.findByText('No pudimos cargar los documentos recibidos.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    await screen.findByRole('list');
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('goes back to the login when the session is gone', async () => {
    const list = vi.fn(() => Promise.resolve({ kind: 'unauthenticated' as const }));
    render(<ReceivedList client={fakeClient(list)} />);

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/login');
    });
  });
});
