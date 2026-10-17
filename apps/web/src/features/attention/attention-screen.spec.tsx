import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthClient, MeResult } from '../auth/auth-client';
import { ATTENTION, fakeAttentionClient } from './attention-fixtures';
import { AttentionScreen } from './attention-screen';

const { replace, router } = vi.hoisted(() => {
  const replace = vi.fn();
  return { replace, router: { push: vi.fn(), replace } };
});
vi.mock('next/navigation', () => ({ useRouter: () => router }));

beforeEach(() => {
  replace.mockClear();
});

const me = (role: string): MeResult => ({
  kind: 'ok',
  session: { userId: 'u1', activeTenant: { tenantId: 't1', role } },
});
const fakeAuth = (result: MeResult = me('owner')) =>
  ({ me: vi.fn(() => Promise.resolve(result)) }) as unknown as AuthClient & {
    me: ReturnType<typeof vi.fn>;
  };

const list = () => screen.findByRole('list', { name: 'Comprobantes que necesitan acción' });

describe('AttentionScreen (HU-E12-04)', () => {
  it('shows a loading state, then one card per document with its reason and deadline', async () => {
    render(<AttentionScreen client={fakeAttentionClient()} auth={fakeAuth()} />);

    expect(screen.getByRole('status', { name: 'Cargando comprobantes' })).toBeInTheDocument();
    const items = within(await list()).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(within(items[0]).getByText('FE 001-001-0004812')).toBeInTheDocument();
    expect(within(items[0]).getByText('Plazo de 72 h vencido')).toBeInTheDocument();
    expect(within(items[1]).getByText('Rechazado por SIFEN')).toBeInTheDocument();
    expect(within(items[1]).getByText('RUC del receptor inexistente')).toBeInTheDocument();
    expect(within(items[1]).getByText('Vence en 20,5 h')).toBeInTheDocument();
    expect(within(items[2]).getByText('Retenido')).toBeInTheDocument();
    expect(within(items[2]).getByText('signing:SigningDataIncompleteError')).toBeInTheDocument();
    expect(within(items[2]).getByText('Sin firmar')).toBeInTheDocument();
  });

  it('titles the screen and counts the documents', async () => {
    render(<AttentionScreen client={fakeAttentionClient()} auth={fakeAuth()} />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Comprobantes que necesitan acción' }),
    ).toBeInTheDocument();
    await list();
    expect(screen.getByText('3 comprobantes')).toBeInTheDocument();
  });

  it('warns when the list is cut', async () => {
    const page = { ...ATTENTION, total: 140, truncated: true };
    render(
      <AttentionScreen client={fakeAttentionClient({ kind: 'ok', page })} auth={fakeAuth()} />,
    );

    expect(await screen.findByText(/Mostrando los 3 más urgentes de 140/)).toBeInTheDocument();
  });

  it('says so when nothing needs action', async () => {
    const page = { items: [], total: 0, truncated: false };
    render(
      <AttentionScreen client={fakeAttentionClient({ kind: 'ok', page })} auth={fakeAuth()} />,
    );

    expect(
      await screen.findByText('No hay comprobantes que necesiten acción.'),
    ).toBeInTheDocument();
  });

  it('shows the corrective actions as unavailable placeholders to owner, admin and emisor', async () => {
    for (const role of ['owner', 'admin', 'emisor']) {
      const { unmount } = render(
        <AttentionScreen client={fakeAttentionClient()} auth={fakeAuth(me(role))} />,
      );
      const first = within((await list()).children[0] as HTMLElement);
      expect(await first.findByRole('button', { name: /Corregir/ })).toBeDisabled();
      expect(first.getByRole('button', { name: /Inutilizar/ })).toBeDisabled();
      expect(first.getAllByText('Disponible próximamente').length).toBeGreaterThan(0);
      unmount();
    }
  });

  it('hides the corrective actions from lector, and while the role is unknown', async () => {
    render(<AttentionScreen client={fakeAttentionClient()} auth={fakeAuth(me('lector'))} />);
    await list();
    expect(screen.queryByRole('button', { name: /Corregir|Inutilizar/ })).not.toBeInTheDocument();

    const pending = fakeAuth();
    pending.me.mockReturnValue(new Promise(() => undefined));
    render(<AttentionScreen client={fakeAttentionClient()} auth={pending} />);
    await screen.findAllByRole('list', { name: 'Comprobantes que necesitan acción' });
    expect(screen.queryByRole('button', { name: /Corregir|Inutilizar/ })).not.toBeInTheDocument();
  });

  it('offers a retry when the API is unavailable', async () => {
    const client = fakeAttentionClient({ kind: 'unavailable' });
    render(<AttentionScreen client={client} auth={fakeAuth()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos cargar');
    client.get.mockResolvedValueOnce({ kind: 'ok', page: ATTENTION });
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await list()).toBeInTheDocument();
  });

  it('sends the user to the login when the session is gone', async () => {
    render(
      <AttentionScreen
        client={fakeAttentionClient({ kind: 'unauthenticated' })}
        auth={fakeAuth()}
      />,
    );

    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/login');
    });
  });
});
