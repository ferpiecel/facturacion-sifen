import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { DocumentsBrowser } from './documents-browser';

const rows = () => screen.queryAllByRole('listitem');

describe('DocumentsBrowser (type tabs and selection)', () => {
  it('filters by type with tabs that carry the period counts and a pressed state', async () => {
    const user = userEvent.setup();
    render(<DocumentsBrowser />);

    const group = screen.getByRole('group', { name: 'Tipo de comprobante' });
    expect(within(group).getByRole('button', { name: /Todos/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(group).getByRole('button', { name: /Facturas/ })).toHaveTextContent('1.210');
    await user.click(within(group).getByRole('button', { name: /Notas de Crédito/ }));
    expect(rows()).toHaveLength(1);
    await user.click(within(group).getByRole('button', { name: /Autofacturas/ }));
    expect(screen.getByText('No hay comprobantes para los filtros aplicados.')).toBeInTheDocument();
  });

  it('selects rows and enables the bulk actions only with a selection', async () => {
    const user = userEvent.setup();
    render(<DocumentsBrowser />);

    const download = screen.getByRole('button', { name: 'Descargar XML Zip' });
    expect(download).toBeDisabled();
    expect(screen.getByText('Seleccionados: 0 comprobantes')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Seleccionar FE 001-001-0004520' }));
    expect(screen.getByText('Seleccionados: 1 comprobante')).toBeInTheDocument();
    expect(download).toBeEnabled();
    await user.click(screen.getByRole('checkbox', { name: 'Seleccionar todos los comprobantes' }));
    expect(screen.getByText('Seleccionados: 5 comprobantes')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Seleccionar todos los comprobantes' }));
    expect(screen.getByText('Seleccionados: 0 comprobantes')).toBeInTheDocument();
  });

  it('counts only the selected rows that the active tab still shows', async () => {
    const user = userEvent.setup();
    render(<DocumentsBrowser />);

    await user.click(screen.getByRole('checkbox', { name: 'Seleccionar FE 001-001-0004520' }));
    await user.click(screen.getByRole('button', { name: /Notas de Crédito/ }));
    expect(screen.getByText('Seleccionados: 0 comprobantes')).toBeInTheDocument();
  });
});
