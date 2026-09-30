import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import HomePage from './page';

describe('HomePage (Panel de Control)', () => {
  it('shows the non-dismissible test-environment legend and no environment toggle', () => {
    render(<HomePage />);

    expect(screen.getByRole('status')).toHaveTextContent('Ambiente de prueba');
    expect(screen.queryByRole('button', { name: /producción|pruebas/i })).not.toBeInTheDocument();
  });

  it('marks the panel as the current page in the main navigation', () => {
    render(<HomePage />);

    const nav = screen.getByRole('navigation', { name: 'Principal' });
    expect(within(nav).getByRole('link', { name: 'Panel de Control' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getAllByRole('link')).toHaveLength(3);
  });

  it('labels icon-only controls for assistive technology', () => {
    render(<HomePage />);

    expect(screen.getByRole('button', { name: 'Notificaciones' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cerrar sesión' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Buscar comprobantes' })).toBeInTheDocument();
  });
});
