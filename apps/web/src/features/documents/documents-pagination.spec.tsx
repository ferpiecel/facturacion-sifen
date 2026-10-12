import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DocumentsBrowser } from './documents-browser';
import { fakeDocumentsClient } from './documents-fixtures';
import { DocumentsHelpBanner } from './documents-help-banner';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

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
