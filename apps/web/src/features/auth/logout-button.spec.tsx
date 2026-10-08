import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthClient } from './auth-client';
import { LogoutButton } from './logout-button';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: replace, replace }) }));

describe('LogoutButton', () => {
  beforeEach(() => replace.mockClear());

  it('ends the session and goes to the login', async () => {
    const client = { logout: vi.fn(() => Promise.resolve()) } as unknown as AuthClient;
    render(<LogoutButton client={client} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Cerrar sesión' }));
    expect(client.logout).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/login');
    });
  });

  it('goes to the login even when the logout request fails', async () => {
    const client = {
      logout: vi.fn(() => Promise.reject(new Error('offline'))),
    } as unknown as AuthClient;
    render(<LogoutButton client={client} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Cerrar sesión' }));
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/login');
    });
  });
});
