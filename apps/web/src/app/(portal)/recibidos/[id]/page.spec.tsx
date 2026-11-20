import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ReceivedDocumentPage from './page';

const { router } = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

// The page uses the real client: stub it so the spec makes no network call, and so the route id is observable.
const { detail } = vi.hoisted(() => ({ detail: vi.fn(() => new Promise<never>(() => undefined)) }));
vi.mock('../../../../features/reception/reception-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../features/reception/reception-client')>()),
  receptionClient: { list: vi.fn(), detail, artifactUrl: vi.fn() },
}));

describe('ReceivedDocumentPage', () => {
  it('renders the detail inside the panel shell with Recibidos as current page', async () => {
    render(await ReceivedDocumentPage({ params: Promise.resolve({ id: 'd1' }) }));

    expect(
      screen.getByRole('heading', { level: 1, name: 'Documento recibido' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Volver a documentos recibidos' })).toHaveAttribute(
      'href',
      '/recibidos',
    );
    expect(detail).toHaveBeenCalledWith('d1');
    const nav = screen.getByRole('navigation', { name: 'Principal' });
    expect(within(nav).getByRole('link', { name: 'Recibidos' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});
