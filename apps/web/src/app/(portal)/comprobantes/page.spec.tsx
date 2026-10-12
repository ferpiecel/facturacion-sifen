import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import ComprobantesPage from './page';

describe('ComprobantesPage (explorer header and KPIs)', () => {
  it('titles the screen with a single top-level heading and a breadcrumb without the brand text', () => {
    render(<ComprobantesPage />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Explorador y Validación de Comprobantes' }),
    ).toBeInTheDocument();
    const crumbs = screen.getByRole('navigation', { name: 'Ruta de navegación' });
    expect(within(crumbs).getByText('Inicio')).toBeInTheDocument();
    expect(within(crumbs).getByText('Comprobantes y KuDE')).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByText('SifenFlow', { exact: true })).not.toBeInTheDocument();
  });

  it('marks Comprobantes y KuDE as the current page in the sidebar', () => {
    render(<ComprobantesPage />);

    const nav = screen.getByRole('navigation', { name: 'Principal' });
    expect(within(nav).getByRole('link', { name: 'Comprobantes y KuDE' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Panel de Control' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('offers the header actions and states the test environment', () => {
    render(<ComprobantesPage />);

    expect(screen.getByRole('button', { name: 'Exportar Fiscal (CSV/XLS)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Verificar Lote DNIT' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nueva Factura' })).toBeInTheDocument();
    expect(screen.getByText('Ambiente de pruebas')).toBeInTheDocument();
  });

  it('hosts the period indicators with a period selector (data comes from the summary API)', () => {
    render(<ComprobantesPage />);

    const kpis = screen.getByRole('region', { name: 'Indicadores del período' });
    expect(
      within(kpis).getByRole('button', { name: '30 días', pressed: true }),
    ).toBeInTheDocument();
    expect(within(kpis).queryByText(/Datos de ejemplo/)).not.toBeInTheDocument();
  });
});
