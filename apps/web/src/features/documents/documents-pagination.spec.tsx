import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DocumentsBrowser } from './documents-browser';
import { fakeDocumentsClient, PAGE } from './documents-fixtures';
import { DocumentsHelpBanner } from './documents-help-banner';

// Stable router, as Next's is: useRemote depends on it, a fresh object per render re-runs its request.
const { router } = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:kude');
  URL.revokeObjectURL = vi.fn();
});

describe('DocumentsBrowser (pagination)', () => {
  it('states the visible range against the total and the page size', async () => {
    render(<DocumentsBrowser client={fakeDocumentsClient()} />);

    const nav = await screen.findByRole('navigation', { name: 'Paginación' });
    expect(within(nav).getByText('Mostrando 1 - 3 de 3 comprobantes')).toBeInTheDocument();
    expect(within(nav).getByRole('combobox', { name: 'Filas por página' })).toHaveValue('20');
  });

  it('marks page 1 as current and disables both arrows when everything fits', async () => {
    render(<DocumentsBrowser client={fakeDocumentsClient()} />);

    const nav = await screen.findByRole('navigation', { name: 'Paginación' });
    expect(within(nav).getByRole('button', { name: 'Página 1' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('button', { name: 'Anterior' })).toBeDisabled();
    expect(within(nav).getByRole('button', { name: 'Siguiente' })).toBeDisabled();
  });
});

describe('DocumentsBrowser (paging)', () => {
  const many = (page: number) => ({
    kind: 'ok' as const,
    page: { items: PAGE.items, page, pageSize: 20, total: 45 },
  });

  it('asks for the next and previous pages and resets to page 1 when the size changes', async () => {
    const user = userEvent.setup();
    const list = vi.fn((query: { page?: number }) => Promise.resolve(many(query.page ?? 1)));
    render(<DocumentsBrowser client={fakeDocumentsClient({ list })} />);

    const nav = await screen.findByRole('navigation', { name: 'Paginación' });
    expect(within(nav).getByRole('button', { name: 'Página 3' })).toBeInTheDocument();
    const next = within(nav).getByRole('button', { name: 'Siguiente' });
    await user.click(next);
    await within(await screen.findByRole('navigation', { name: 'Paginación' })).findByRole(
      'button',
      {
        name: 'Página 2',
        current: 'page',
      },
    );
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, pageSize: 20 }));
    expect(next).toBeInTheDocument();
    expect(next).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Anterior' }));
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filas por página' }), '50');
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, pageSize: 50 }));
  });
});

describe('DocumentsHelpBanner', () => {
  it('states the cancellation windows of the backlog (48 h for invoices, 168 h for the rest)', () => {
    render(<DocumentsHelpBanner />);

    expect(
      screen.getByText('¿Dudas sobre cómo anular o rectificar un comprobante electrónico?'),
    ).toBeInTheDocument();
    expect(screen.getByText(/48 hs.*facturas.*168 hs/)).toBeInTheDocument();
    expect(screen.queryByText(/72/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Ver tutorial de 2 minutos/ })).toBeInTheDocument();
  });
});
