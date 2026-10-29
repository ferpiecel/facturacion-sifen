import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DocumentsBrowser } from './documents-browser';
import { fakeDocumentsClient } from './documents-fixtures';

// Stable router, as Next's is: useRemote depends on it, a fresh object per render re-runs its request.
const { router } = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:kude');
  URL.revokeObjectURL = vi.fn();
});

describe('DocumentsBrowser (type tabs and selection)', () => {
  it('asks the API for the chosen type and marks the tab as pressed', async () => {
    const user = userEvent.setup();
    const client = fakeDocumentsClient();
    render(<DocumentsBrowser client={client} />);

    const group = screen.getByRole('group', { name: 'Tipo de comprobante' });
    expect(within(group).getByRole('button', { name: 'Todos' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(within(group).getByRole('button', { name: 'Notas de Crédito' }));
    expect(within(group).getByRole('button', { name: 'Notas de Crédito' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(client.list).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'NCE', page: 1 }));
    await user.click(within(group).getByRole('button', { name: 'Autofacturas' }));
    expect(client.list).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'AFE' }));
  });

  it('selects rows and enables the bulk actions only with a selection', async () => {
    const user = userEvent.setup();
    render(<DocumentsBrowser client={fakeDocumentsClient()} />);

    const download = screen.getByRole('button', { name: 'Descargar XML Zip' });
    expect(download).toBeDisabled();
    expect(screen.getByText('Seleccionados: 0 comprobantes')).toBeInTheDocument();
    await user.click(
      await screen.findByRole('checkbox', { name: 'Seleccionar FE 001-001-0004520' }),
    );
    expect(screen.getByText('Seleccionados: 1 comprobante')).toBeInTheDocument();
    expect(download).toBeEnabled();
    await user.click(screen.getByRole('checkbox', { name: 'Seleccionar todos los comprobantes' }));
    expect(screen.getByText('Seleccionados: 3 comprobantes')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Seleccionar todos los comprobantes' }));
    expect(screen.getByText('Seleccionados: 0 comprobantes')).toBeInTheDocument();
  });
});
