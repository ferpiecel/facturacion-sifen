import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ReceivedDocumentsPage from './page';

const { router } = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

describe('ReceivedDocumentsPage', () => {
  it('renders inside the panel shell and marks Recibidos as the current page', () => {
    render(<ReceivedDocumentsPage />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Documentos recibidos' }),
    ).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Principal' });
    expect(within(nav).getByRole('link', { name: 'Recibidos' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Panel de Control' })).not.toHaveAttribute(
      'aria-current',
    );
  });
});
