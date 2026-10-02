import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { DocumentsBrowser } from './documents-browser';
import { DocumentsHelpBanner } from './documents-help-banner';

describe('DocumentsBrowser (pagination)', () => {
  it('states the visible range against the period total and the page size', () => {
    render(<DocumentsBrowser />);

    const nav = screen.getByRole('navigation', { name: 'Paginación' });
    expect(within(nav).getByText('Mostrando 1 - 5 de 1.428 comprobantes')).toBeInTheDocument();
    expect(within(nav).getByRole('combobox', { name: 'Filas por página' })).toHaveValue('5');
  });

  it('marks page 1 as current, disables Anterior and links to the last page', () => {
    render(<DocumentsBrowser />);

    const nav = screen.getByRole('navigation', { name: 'Paginación' });
    expect(within(nav).getByRole('button', { name: 'Página 1' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('button', { name: 'Página 286' })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'Anterior' })).toBeDisabled();
    expect(within(nav).getByRole('button', { name: 'Siguiente' })).toBeEnabled();
  });

  it('counts the filtered rows instead of the period total', async () => {
    const user = userEvent.setup();
    render(<DocumentsBrowser />);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Estado' }), 'rejected');
    expect(screen.getByText('Mostrando 1 - 1 de 1 comprobantes')).toBeInTheDocument();
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
