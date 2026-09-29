import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import HomePage from './page';

describe('HomePage (Panel de Control)', () => {
  it('welcomes the user with the brand name in a single top-level heading', () => {
    render(<HomePage />);

    expect(
      screen.getByRole('heading', { level: 1, name: '¡Bienvenido a SifenFlow!' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Datos de ejemplo')).toBeInTheDocument();
  });

  it('shows the brand only as a logo, with no brand wordmark or DNIT tagline next to it', () => {
    render(<HomePage />);

    expect(screen.getAllByRole('img', { name: 'SifenFlow' }).length).toBeGreaterThan(0);
    expect(screen.queryByText('SifenFlow', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText('DNIT FACTURACIÓN PY')).not.toBeInTheDocument();
  });

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

  it('lists recent documents with status, 44-digit CDC and Guaraní amounts', () => {
    render(<HomePage />);

    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(6);
    expect(within(table).getAllByText('Aprobado SIFEN')).toHaveLength(5);
    expect(within(table).getAllByRole('button', { name: 'Copiar CDC' })).toHaveLength(5);
    expect(within(table).getByText('01-80012345-0...585')).toBeInTheDocument();
    expect(within(table).getByText('₲ 12.850.000')).toBeInTheDocument();
    expect(within(table).getByText('-₲ 650.000')).toHaveClass('text-error');
  });

  it('labels icon-only controls for assistive technology', () => {
    render(<HomePage />);

    expect(screen.getByRole('button', { name: 'Notificaciones' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cerrar sesión' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Buscar comprobantes' })).toBeInTheDocument();
  });
});
