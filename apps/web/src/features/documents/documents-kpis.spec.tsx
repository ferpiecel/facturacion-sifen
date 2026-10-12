import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DocumentsKpis } from './documents-kpis';
import { EMPTY, fakeSummaryClient } from './summary-fixtures';

const { replace, router } = vi.hoisted(() => {
  const replace = vi.fn();
  return { replace, router: { push: vi.fn(), replace } };
});
vi.mock('next/navigation', () => ({ useRouter: () => router }));

beforeEach(() => {
  replace.mockClear();
});

const region = () => screen.findByRole('region', { name: 'Indicadores del período' });

describe('DocumentsKpis (period summary)', () => {
  it('shows a loading state, then the four indicators of the API summary', async () => {
    const client = fakeSummaryClient();
    render(<DocumentsKpis client={client} />);

    expect(screen.getByRole('status', { name: 'Cargando indicadores' })).toBeInTheDocument();
    const kpis = await region();
    expect(client.get).toHaveBeenCalledWith({
      from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as string,
      to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as string,
    });
    expect(within(kpis).getByText('Emitidos (últimos 30 días)')).toBeInTheDocument();
    expect(within(kpis).getByText('120')).toBeInTheDocument();
    expect(within(kpis).getByText('+20.0%')).toBeInTheDocument();
    expect(within(kpis).getByText('₲ 16.100.000')).toBeInTheDocument();
    expect(within(kpis).getByText('100')).toBeInTheDocument();
    expect(within(kpis).getByText('83.3% del total')).toBeInTheDocument();
    expect(within(kpis).getByText('5')).toHaveClass('text-error');
    expect(within(kpis).queryByText(/Datos de ejemplo/)).not.toBeInTheDocument();
    expect(within(kpis).queryByText(/Meta|Demora|BullMQ|Redis/)).not.toBeInTheDocument();
  });

  it('exposes the approval ratio as a progress bar and lists the top rejection codes', async () => {
    render(<DocumentsKpis client={fakeSummaryClient()} />);

    const bar = await screen.findByRole('progressbar', { name: 'Aprobados por SIFEN' });
    expect(bar).toHaveAttribute('aria-valuenow', '83.3');
    expect(bar.firstElementChild).toHaveStyle({ width: '83.3%' });
    expect(screen.getByText('Motivos: 1321 (3) · 2001 (2)')).toBeInTheDocument();
  });

  it('highlights overdue pending documents against the 72 h deadline', async () => {
    render(<DocumentsKpis client={fakeSummaryClient()} />);

    const kpis = await region();
    expect(within(kpis).getByText('15')).toBeInTheDocument();
    expect(within(kpis).getByText('2 vencidos (72 h)')).toHaveClass('text-error');
    expect(within(kpis).getByText('4 por vencer')).toBeInTheDocument();
    expect(within(kpis).getByText(/Vence primero: 13\/10\/2026 09:00/)).toBeInTheDocument();
  });

  it('shows zeros and no percentages for a tenant without documents', async () => {
    render(<DocumentsKpis client={fakeSummaryClient({ kind: 'ok', summary: EMPTY })} />);

    const kpis = await region();
    expect(within(kpis).getAllByText('0')).toHaveLength(4);
    expect(within(kpis).getByText('Sin período previo para comparar')).toBeInTheDocument();
    expect(within(kpis).getByText('Sin comprobantes')).toBeInTheDocument();
    expect(within(kpis).getByText('Sin pendientes')).toBeInTheDocument();
    expect(within(kpis).queryByText(/NaN|Infinity/)).not.toBeInTheDocument();
  });

  it('notes the documents in another currency that the PYG amount leaves out', async () => {
    render(<DocumentsKpis client={fakeSummaryClient()} />);

    expect(await screen.findByText('2 en otra moneda, fuera del monto')).toBeInTheDocument();
  });

  it('reloads the summary when the period changes', async () => {
    const user = userEvent.setup();
    const client = fakeSummaryClient();
    render(<DocumentsKpis client={client} />);
    await region();

    await user.click(screen.getByRole('button', { name: '7 días' }));

    expect(screen.getByRole('button', { name: '7 días' })).toHaveAttribute('aria-pressed', 'true');
    expect(client.get).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('Emitidos (últimos 7 días)')).toBeInTheDocument();
  });

  it('offers a retry when the summary is unavailable', async () => {
    const user = userEvent.setup();
    const client = fakeSummaryClient({ kind: 'unavailable' });
    render(<DocumentsKpis client={client} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos cargar los indicadores');
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(client.get).toHaveBeenCalledTimes(2);
  });

  it('sends the user back to the login when the session is gone', async () => {
    render(<DocumentsKpis client={fakeSummaryClient({ kind: 'unauthenticated' })} />);

    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/login');
    });
  });

  it('never shows the previous period numbers under the new period while it loads', async () => {
    const user = userEvent.setup();
    const client = fakeSummaryClient();
    render(<DocumentsKpis client={client} />);
    await region();
    client.get.mockReturnValueOnce(new Promise(() => undefined));

    await user.click(screen.getByRole('button', { name: '90 días' }));

    expect(screen.getByRole('status', { name: 'Cargando indicadores' })).toBeInTheDocument();
    expect(screen.queryByText('120')).not.toBeInTheDocument();
    expect(screen.queryByText(/Emitidos/)).not.toBeInTheDocument();
  });

  it('hides a stale error alert while the next request is in flight', async () => {
    const user = userEvent.setup();
    const client = fakeSummaryClient({ kind: 'unavailable' });
    render(<DocumentsKpis client={client} />);
    await screen.findByRole('alert');
    client.get.mockReturnValueOnce(new Promise(() => undefined));

    await user.click(screen.getByRole('button', { name: '7 días' }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Indicadores del período' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
  });
});
