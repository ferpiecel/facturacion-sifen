import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { EMPTY, fakeSummaryClient } from '../documents/summary-fixtures';
import { PanelKpis } from './panel-kpis';

const { router } = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

describe('PanelKpis (panel indicators from the summary API)', () => {
  it('shows a loading state, then billing, issued, queue and rejected from the last 30 days', async () => {
    const client = fakeSummaryClient();
    render(<PanelKpis client={client} />);

    expect(screen.getByRole('status', { name: 'Cargando indicadores' })).toBeInTheDocument();
    const kpis = await screen.findByRole('region', { name: 'Indicadores' });
    expect(within(kpis).getByText('Facturación (30 días)')).toBeInTheDocument();
    expect(within(kpis).getByText('₲ 16.100.000')).toBeInTheDocument();
    expect(within(kpis).getByText('120')).toBeInTheDocument();
    expect(within(kpis).getByText('+20.0% vs período anterior')).toBeInTheDocument();
    expect(within(kpis).getByText('83.3% aprobado DNIT')).toBeInTheDocument();
    expect(within(kpis).getByText('15')).toBeInTheDocument();
    expect(within(kpis).getByText('2 vencidos (72 h)')).toHaveClass('text-error');
    expect(within(kpis).getByText('5')).toBeInTheDocument();
    expect(within(kpis).queryByText(/latencia|Lote #|empresas vinculadas|vs ayer/)).toBeNull();
  });

  it('shows zeros and no percentages for a tenant without documents', async () => {
    render(<PanelKpis client={fakeSummaryClient({ kind: 'ok', summary: EMPTY })} />);

    const kpis = await screen.findByRole('region', { name: 'Indicadores' });
    expect(within(kpis).getByText('₲ 0')).toBeInTheDocument();
    expect(within(kpis).getByText('Sin período previo para comparar')).toBeInTheDocument();
    expect(within(kpis).getByText('Sin pendientes')).toBeInTheDocument();
    expect(within(kpis).queryByText(/NaN|Infinity/)).toBeNull();
  });

  it('offers a retry when the summary is unavailable', async () => {
    const user = userEvent.setup();
    const client = fakeSummaryClient({ kind: 'unavailable' });
    render(<PanelKpis client={client} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos cargar los indicadores');
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(client.get).toHaveBeenCalledTimes(2);
  });
});
