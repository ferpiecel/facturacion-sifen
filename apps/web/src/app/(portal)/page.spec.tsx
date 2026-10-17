import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import HomePage from './page';

vi.mock('../../features/panel/recent-documents', () => ({
  RecentDocuments: () => <section aria-label="Comprobantes recientes" />,
}));

describe('HomePage (Panel de Control)', () => {
  it('welcomes the user with the brand name in a single top-level heading', () => {
    render(<HomePage />);

    expect(
      screen.getByRole('heading', { level: 1, name: '¡Bienvenido a SifenFlow!' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Datos de ejemplo/)).not.toBeInTheDocument();
  });

  it('shows the brand only as a logo, with no brand wordmark or DNIT tagline next to it', () => {
    render(<HomePage />);

    expect(screen.getAllByRole('img', { name: 'SifenFlow' }).length).toBeGreaterThan(0);
    expect(screen.queryByText('SifenFlow', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText('DNIT FACTURACIÓN PY')).not.toBeInTheDocument();
  });

  it('shows the non-dismissible test-environment legend and no environment toggle', () => {
    render(<HomePage />);

    expect(screen.getByText(/Ambiente de prueba/).closest('[role="status"]')).toBeInTheDocument();
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

  it('hosts the recent documents section', () => {
    render(<HomePage />);

    expect(screen.getByRole('region', { name: 'Comprobantes recientes' })).toBeInTheDocument();
  });

  it('keeps the hero text readable over the whole gradient', () => {
    render(<HomePage />);

    const hero = screen.getByRole('heading', { level: 1 }).closest('div.relative.overflow-hidden');
    expect(hero).toHaveClass('to-primary-container');
    expect(hero?.className).not.toContain('surface-container-high');
    expect(screen.getByText(/Tu asistente inteligente/)).toHaveClass('text-white');
  });
});
