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

  it('shows the four period indicators without infrastructure jargon', () => {
    render(<ComprobantesPage />);

    const kpis = screen.getByRole('region', { name: 'Indicadores del período' });
    expect(within(kpis).getByText('Emitidos (últimos 30 días)')).toBeInTheDocument();
    expect(within(kpis).getByText('1.428')).toBeInTheDocument();
    expect(within(kpis).getByText('+14.2%')).toBeInTheDocument();
    expect(within(kpis).getByText('1.398')).toBeInTheDocument();
    expect(within(kpis).getByText('97.9% del total')).toBeInTheDocument();
    expect(within(kpis).getByText('24')).toBeInTheDocument();
    expect(within(kpis).getByText('6')).toHaveClass('text-error');
    expect(within(kpis).queryByText(/BullMQ|Redis/i)).not.toBeInTheDocument();
  });

  it('exposes the approval ratio as a progress bar and links to the rejection reasons', () => {
    render(<ComprobantesPage />);

    expect(screen.getByRole('progressbar', { name: 'Aprobados por SIFEN' })).toHaveAttribute(
      'aria-valuenow',
      '97.9',
    );
    const bar = screen.getByRole('progressbar', { name: 'Aprobados por SIFEN' });
    expect(bar.firstElementChild).toHaveStyle({ width: '97.9%' });
    expect(screen.getByRole('button', { name: /Ver motivos \(1321\)/ })).toBeInTheDocument();
  });
});
