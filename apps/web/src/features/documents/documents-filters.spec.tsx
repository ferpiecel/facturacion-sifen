import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DocumentsBrowser } from './documents-browser';
import { fakeDocumentsClient } from './documents-fixtures';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:kude');
  URL.revokeObjectURL = vi.fn();
});

function setup() {
  const user = userEvent.setup();
  const client = fakeDocumentsClient();
  render(<DocumentsBrowser client={client} />);
  const lastQuery = () => vi.mocked(client.list).mock.lastCall?.[0];
  return { user, client, lastQuery };
}

describe('DocumentsBrowser (filters)', () => {
  it('offers the document types of the backlog and the lifecycle statuses', () => {
    setup();

    const labels = (name: string) =>
      within(screen.getByRole('combobox', { name }))
        .getAllByRole('option')
        .map((option) => option.textContent);
    expect(labels('Tipo de documento')).toEqual([
      'Todos los Documentos',
      'Facturas Electrónicas (FE)',
      'Notas de Crédito (NCE)',
      'Notas de Débito (NDE)',
      'Autofacturas (AFE)',
    ]);
    expect(labels('Estado')).toEqual([
      'Todos los estados',
      'Borrador',
      'Firmado',
      'En lote',
      'Aprobado SIFEN',
      'Aprobado con observación',
      'Rechazado',
      'Cancelado',
      'Inutilizado',
    ]);
  });

  it('searches on submit with the trimmed text and clears it from its chip', async () => {
    const { user, lastQuery } = setup();

    await user.type(
      screen.getByRole('searchbox', { name: 'Filtrar el listado de comprobantes' }),
      '  80034567 {Enter}',
    );
    expect(lastQuery()).toMatchObject({ q: '80034567', page: 1 });
    const applied = await screen.findByRole('group', { name: 'Filtros aplicados' });
    await user.click(
      within(applied).getByRole('button', { name: 'Quitar filtro Búsqueda: 80034567' }),
    );
    expect(lastQuery()).toMatchObject({ q: '' });
    expect(screen.getByRole('searchbox')).toHaveValue('');
  });

  it('filters by status and date range and resets everything with "Limpiar filtros"', async () => {
    const { user, lastQuery } = setup();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Estado' }), 'rechazado');
    expect(lastQuery()).toMatchObject({ status: 'rechazado' });
    await user.type(screen.getByLabelText('Desde'), '2026-10-01');
    await user.type(screen.getByLabelText('Hasta'), '2026-10-31');
    expect(lastQuery()).toMatchObject({
      status: 'rechazado',
      from: '2026-10-01',
      to: '2026-10-31',
    });
    const applied = screen.getByRole('group', { name: 'Filtros aplicados' });
    await user.click(within(applied).getByRole('button', { name: 'Quitar filtro Rechazado' }));
    expect(lastQuery()).toMatchObject({ status: '', from: '2026-10-01' });
    await user.click(screen.getByRole('button', { name: 'Limpiar filtros' }));
    expect(lastQuery()).toMatchObject({ status: '', from: '', to: '' });
    expect(screen.queryByRole('group', { name: 'Filtros aplicados' })).not.toBeInTheDocument();
  });

  it('keeps the type select and the tabs in sync', async () => {
    const { user, lastQuery } = setup();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Tipo de documento' }), 'FE');
    expect(lastQuery()).toMatchObject({ type: 'FE' });
    expect(screen.getByRole('button', { name: 'Facturas' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
