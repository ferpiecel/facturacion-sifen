import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ActionRequiredPage from './page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('../../../features/attention/attention-screen', () => ({
  AttentionScreen: () => <h1>Comprobantes que necesitan acción</h1>,
}));

describe('ActionRequiredPage', () => {
  it('renders the screen inside the panel shell and marks it as the current page', () => {
    render(<ActionRequiredPage />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Comprobantes que necesitan acción' }),
    ).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Principal' });
    expect(within(nav).getByRole('link', { name: 'Acción requerida' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Panel de Control' })).not.toHaveAttribute(
      'aria-current',
    );
  });
});
