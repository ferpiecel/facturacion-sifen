import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DocumentsDetail } from './documents-detail';
import { DETAIL, fakeDocumentsClient, ITEM } from './documents-fixtures';

const panel = () => screen.getByRole('region', { name: 'Detalle del comprobante' });
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

describe('DocumentsDetail', () => {
  it('asks to pick a document when none is selected and calls nothing', () => {
    const client = fakeDocumentsClient();
    render(<DocumentsDetail documentId={undefined} client={client} />);

    expect(
      within(panel()).getByText('Selecciona un comprobante para ver su detalle.'),
    ).toBeInTheDocument();
    expect(client.detail).not.toHaveBeenCalled();
  });

  it('shows a loading state, then the header with number, status and environment', async () => {
    render(<DocumentsDetail documentId={ITEM.id} client={fakeDocumentsClient()} />);

    expect(within(panel()).getByRole('status')).toHaveTextContent('Cargando comprobante');
    expect(
      await within(panel()).findByRole('heading', { level: 2, name: 'FE 001-001-0004520' }),
    ).toBeInTheDocument();
    expect(within(panel()).getByText('Aprobado SIFEN')).toBeInTheDocument();
    expect(within(panel()).getByText('Ambiente: Pruebas')).toBeInTheDocument();
  });

  it('names the production environment', async () => {
    const client = fakeDocumentsClient({
      detail: vi.fn(() =>
        Promise.resolve({ kind: 'ok' as const, document: { ...DETAIL, environment: 'production' } }),
      ),
    });
    render(<DocumentsDetail documentId={ITEM.id} client={client} />);

    expect(await within(panel()).findByText('Ambiente: Producción')).toBeInTheDocument();
  });

  it('explains a document that is not in the active company (404)', async () => {
    const client = fakeDocumentsClient({
      detail: vi.fn(() => Promise.resolve({ kind: 'not_found' as const })),
    });
    render(<DocumentsDetail documentId="x" client={client} />);

    expect(await within(panel()).findByRole('alert')).toHaveTextContent(
      'El comprobante no existe o no pertenece a la empresa activa.',
    );
  });

  it('offers to retry when the API is unavailable', async () => {
    const user = userEvent.setup();
    const detail = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'unavailable' })
      .mockResolvedValueOnce({ kind: 'ok', document: DETAIL });
    render(<DocumentsDetail documentId={ITEM.id} client={fakeDocumentsClient({ detail })} />);

    expect(await within(panel()).findByRole('alert')).toHaveTextContent(
      'No pudimos cargar el comprobante',
    );
    await user.click(within(panel()).getByRole('button', { name: 'Reintentar' }));
    expect(await within(panel()).findByRole('heading', { level: 2 })).toBeInTheDocument();
    expect(detail).toHaveBeenCalledTimes(2);
  });

  it('sends the user back to the login when the session is gone', async () => {
    const client = fakeDocumentsClient({
      detail: vi.fn(() => Promise.resolve({ kind: 'unauthenticated' as const })),
    });
    render(<DocumentsDetail documentId={ITEM.id} client={client} />);

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/login');
    });
  });

  it('loads the new document when the selection changes', async () => {
    const client = fakeDocumentsClient();
    const { rerender } = render(<DocumentsDetail documentId="a" client={client} />);
    await within(panel()).findByRole('heading', { level: 2 });

    rerender(<DocumentsDetail documentId="b" client={client} />);

    await waitFor(() => {
      expect(client.detail).toHaveBeenLastCalledWith('b');
    });
    expect(client.detail).toHaveBeenCalledTimes(2);
  });
});
