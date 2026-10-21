import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { fakeDocumentsClient, ITEM, NOTE, PAGE, REJECTED } from '../documents/documents-fixtures';
import { RecentDocuments } from './recent-documents';

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace }) }));

describe('RecentDocuments (documents API, last five)', () => {
  it('asks for the five newest documents and lists them with status, CDC and amount', async () => {
    const client = fakeDocumentsClient();
    render(<RecentDocuments client={client} />);

    expect(screen.getByRole('status', { name: 'Cargando comprobantes recientes' })).toBeVisible();
    const table = await screen.findByRole('table', { name: 'Comprobantes Electrónicos Recientes' });
    expect(client.list).toHaveBeenCalledWith({ page: 1, pageSize: 5 });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(PAGE.items.length + 1);
    expect(within(rows[1]).getByText('001-001-0004520')).toBeInTheDocument();
    expect(within(rows[1]).getByText('TELECOMUNICACIONES DEL SUR S.A.')).toBeInTheDocument();
    expect(within(rows[1]).getByText('RUC: 80034567-3')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Aprobado SIFEN')).toBeInTheDocument();
    expect(within(rows[1]).getByText('₲ 16.100.000')).toBeInTheDocument();
    expect(within(rows[2]).getByText('NCE')).toBeInTheDocument();
    expect(within(rows[3]).getByText('Rechazado')).toBeInTheDocument();
    expect(within(rows[3]).queryByText(/RUC:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Datos de ejemplo/)).not.toBeInTheDocument();
  });

  it('keeps the table accessible: column scopes and a focusable scroll area', async () => {
    render(<RecentDocuments client={fakeDocumentsClient()} />);

    const table = await screen.findByRole('table');
    for (const header of within(table).getAllByRole('columnheader')) {
      expect(header).toHaveAttribute('scope', 'col');
    }
    expect(screen.getByRole('region', { name: 'Tabla de comprobantes recientes' })).toHaveAttribute(
      'tabindex',
      '0',
    );
  });

  it('links each row and the header to the explorer', async () => {
    render(<RecentDocuments client={fakeDocumentsClient()} />);

    await screen.findByRole('table');
    expect(screen.getByRole('link', { name: /Ver todos/i })).toHaveAttribute(
      'href',
      '/comprobantes',
    );
  });

  it('says so when there are no documents yet', async () => {
    const client = fakeDocumentsClient({
      list: vi.fn(() =>
        Promise.resolve({ kind: 'ok' as const, page: { ...PAGE, items: [], total: 0 } }),
      ),
    });
    render(<RecentDocuments client={client} />);

    expect(await screen.findByText('Todavía no emitiste comprobantes.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('offers a retry when the API is unavailable', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'unavailable' })
      .mockResolvedValue({ kind: 'ok', page: { ...PAGE, items: [ITEM, NOTE, REJECTED] } });
    render(<RecentDocuments client={fakeDocumentsClient({ list })} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos cargar');
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });

  it('sends the user to the login when the session is gone', async () => {
    const list = vi.fn(() => Promise.resolve({ kind: 'unauthenticated' as const }));
    render(<RecentDocuments client={fakeDocumentsClient({ list })} />);

    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/login');
    });
  });
});
