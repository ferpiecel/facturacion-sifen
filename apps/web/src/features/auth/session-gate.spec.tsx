import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthClient, MeResult } from './auth-client';
import { SessionGate } from './session-gate';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: replace, replace }) }));

function setup(...results: MeResult[]) {
  const queue = [...results];
  const client = {
    me: vi.fn(() => Promise.resolve(queue.shift() ?? { kind: 'unavailable' as const })),
  } as unknown as AuthClient;
  render(
    <SessionGate client={client}>
      <p>Contenido protegido</p>
    </SessionGate>,
  );
  return client;
}

describe('SessionGate', () => {
  beforeEach(() => replace.mockClear());

  it('shows a polite loading status and no content until the session is known', () => {
    setup({ kind: 'ok', session: { userId: 'u', activeTenant: { tenantId: 't', role: 'owner' } } });
    expect(screen.getByRole('status')).toHaveTextContent('Verificando sesión');
    expect(screen.queryByText('Contenido protegido')).not.toBeInTheDocument();
  });

  it('renders the content for a session with an active tenant', async () => {
    setup({ kind: 'ok', session: { userId: 'u', activeTenant: { tenantId: 't', role: 'owner' } } });
    expect(await screen.findByText('Contenido protegido')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('sends an unauthenticated user to the login', async () => {
    setup({ kind: 'unauthenticated' });
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
    expect(screen.queryByText('Contenido protegido')).not.toBeInTheDocument();
  });

  it('sends a user without an active tenant to the picker', async () => {
    setup({ kind: 'ok', session: { userId: 'u', activeTenant: null } });
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/seleccionar-empresa'));
    expect(screen.queryByText('Contenido protegido')).not.toBeInTheDocument();
  });

  it('offers a retry when the API is unavailable and keeps the content hidden', async () => {
    const client = setup(
      { kind: 'unavailable' },
      { kind: 'ok', session: { userId: 'u', activeTenant: { tenantId: 't', role: 'owner' } } },
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos verificar tu sesión');
    expect(screen.queryByText('Contenido protegido')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('Contenido protegido')).toBeInTheDocument();
    expect(client.me).toHaveBeenCalledTimes(2);
  });
});
