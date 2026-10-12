import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DocumentsBrowser } from './documents-browser';
import { fakeDocumentsClient, ITEM, PAGE, REJECTED } from './documents-fixtures';

const { replace, router } = vi.hoisted(() => {
  const replace = vi.fn();
  return { replace, router: { push: vi.fn(), replace } };
});
vi.mock('next/navigation', () => ({ useRouter: () => router }));

beforeEach(() => {
  replace.mockClear();
  URL.createObjectURL = vi.fn(() => 'blob:kude');
  URL.revokeObjectURL = vi.fn();
});

const rowOf = (name: string) => screen.findByRole('listitem', { name });

describe('DocumentsBrowser (document list)', () => {
  it('shows a loading state, then one row per document of the API page', async () => {
    const client = fakeDocumentsClient();
    render(<DocumentsBrowser client={client} />);

    expect(screen.getByRole('status', { name: 'Cargando comprobantes' })).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Comprobantes' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(PAGE.items.length);
    expect(client.list).toHaveBeenCalledWith({ type: '' });
  });

  it('opens the detail of the first document and switches it from a row', async () => {
    const user = userEvent.setup();
    const client = fakeDocumentsClient();
    render(<DocumentsBrowser client={client} />);

    const panel = await screen.findByRole('region', { name: 'Detalle del comprobante' });
    await within(panel).findByRole('heading', { level: 2 });
    expect(client.detail).toHaveBeenLastCalledWith(ITEM.id);
    const row = await rowOf('FE 001-001-0004518');
    await user.click(within(row).getByRole('button', { name: 'Ver detalle' }));
    expect(client.detail).toHaveBeenLastCalledWith(REJECTED.id);
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(await rowOf('NCE 001-001-0000104')).not.toHaveAttribute('aria-current');
  });

  it('explains an empty result', async () => {
    const list = vi.fn(() =>
      Promise.resolve({ kind: 'ok' as const, page: { ...PAGE, items: [], total: 0 } }),
    );
    render(<DocumentsBrowser client={fakeDocumentsClient({ list })} />);

    expect(
      await screen.findByText('No hay comprobantes para los filtros aplicados.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Selecciona un comprobante para ver su detalle.')).toBeInTheDocument();
  });

  it('shows an error with a retry, and reloads on the refresh button', async () => {
    const user = userEvent.setup();
    const list = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'unavailable' })
      .mockResolvedValue({ kind: 'ok', page: PAGE });
    render(<DocumentsBrowser client={fakeDocumentsClient({ list })} />);

    expect(await screen.findByText('No pudimos cargar los comprobantes.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    await rowOf('FE 001-001-0004520');
    await user.click(screen.getByRole('button', { name: 'Actualizar datos' }));
    await rowOf('FE 001-001-0004520');
    expect(list).toHaveBeenCalledTimes(3);
  });

  it('goes back to the login when the session is gone', async () => {
    const list = vi.fn(() => Promise.resolve({ kind: 'unauthenticated' as const }));
    render(<DocumentsBrowser client={fakeDocumentsClient({ list })} />);

    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/login');
    });
  });
});
