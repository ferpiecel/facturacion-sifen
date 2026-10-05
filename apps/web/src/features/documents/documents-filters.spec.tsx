import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { DocumentsBrowser } from './documents-browser';

const rows = () => screen.queryAllByRole('listitem');

describe('DocumentsBrowser (filters)', () => {
  it('offers only the document types of the backlog in the type filter', () => {
    render(<DocumentsBrowser />);

    const options = within(screen.getByRole('combobox', { name: 'Tipo de documento' }))
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(options).toEqual([
      'Todos los Documentos',
      'Facturas Electrónicas (FE)',
      'Notas de Crédito (NCE)',
      'Notas de Débito (NDE)',
      'Autofacturas (AFE)',
    ]);
  });

  it('searches by CDC, RUC, number or business name and clears with its chip', async () => {
    const user = userEvent.setup();
    render(<DocumentsBrowser />);

    // Paste instead of type: one input event per query rather than one full
    // re-render per keystroke, which pushed this test past 5 s under coverage.
    const search = screen.getByRole('searchbox', { name: 'Filtrar el listado de comprobantes' });
    await user.click(search);
    await user.paste('80034567');
    expect(rows()).toHaveLength(1);
    await user.clear(search);
    await user.paste('agroganadera');
    expect(rows()).toHaveLength(1);
    await user.clear(search);
    await user.paste('0004518');
    expect(screen.getByRole('listitem', { name: 'FE 001-001-0004518' })).toBeInTheDocument();
  });

  it('filters by status and establishment and lists the applied filters as removable chips', async () => {
    const user = userEvent.setup();
    render(<DocumentsBrowser />);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Estado' }), 'rejected');
    expect(rows()).toHaveLength(1);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sucursal' }), '002');
    expect(screen.getByText('No hay comprobantes para los filtros aplicados.')).toBeInTheDocument();
    const applied = screen.getByRole('group', { name: 'Filtros aplicados' });
    await user.click(within(applied).getByRole('button', { name: 'Quitar filtro Rechazado' }));
    expect(rows()).toHaveLength(1);
    expect(screen.getByRole('listitem', { name: 'FE 002-001-0001188' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Limpiar filtros' }));
    expect(rows()).toHaveLength(5);
    expect(screen.queryByRole('group', { name: 'Filtros aplicados' })).not.toBeInTheDocument();
  });

  it('keeps only documents with observations or rejections on request', async () => {
    const user = userEvent.setup();
    render(<DocumentsBrowser />);

    await user.click(screen.getByRole('checkbox', { name: 'Solo con observaciones o rechazos' }));
    expect(rows()).toHaveLength(1);
  });
});
