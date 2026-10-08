import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthClient, LoginResult } from './auth-client';
import { LoginForm } from './login-form';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: push }) }));

function setup(result: LoginResult) {
  const client = { login: vi.fn(() => Promise.resolve(result)) } as unknown as AuthClient;
  render(<LoginForm client={client} />);
  return client;
}

async function submit(email = 'ana@acme.py', password = 'una-clave-larga') {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Correo electrónico'), email);
  await user.type(screen.getByLabelText('Contraseña'), password);
  await user.click(screen.getByRole('button', { name: 'Ingresar' }));
  return user;
}

describe('LoginForm', () => {
  beforeEach(() => push.mockClear());

  it('has labelled, autofilled-friendly fields', () => {
    setup({ kind: 'mfa_required' });
    expect(screen.getByLabelText('Correo electrónico')).toHaveAttribute('type', 'email');
    expect(screen.getByLabelText('Correo electrónico')).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText('Contraseña')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Contraseña')).toHaveAttribute('autocomplete', 'current-password');
  });

  it('sends the credentials and goes to the MFA step', async () => {
    const client = setup({ kind: 'mfa_required' });
    await submit();
    expect(client.login).toHaveBeenCalledWith('ana@acme.py', 'una-clave-larga');
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/login/mfa');
    });
  });

  it('does not call the API with an empty form and says what is missing', async () => {
    const client = setup({ kind: 'mfa_required' });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Ingresar' }));
    expect(client.login).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Ingresá tu correo y tu contraseña.');
  });

  it('shows one generic error that does not reveal which field failed, and refocuses the email', async () => {
    setup({ kind: 'invalid' });
    await submit();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Correo o contraseña incorrectos.');
    expect(screen.getByLabelText('Correo electrónico')).toHaveFocus();
    expect(screen.getByLabelText('Correo electrónico')).toHaveAttribute('aria-invalid', 'true');
    expect(push).not.toHaveBeenCalled();
  });

  it('shows the throttled state', async () => {
    setup({ kind: 'throttled' });
    await submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Demasiados intentos');
  });

  it('shows the unavailable state', async () => {
    setup({ kind: 'unavailable' });
    await submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos conectar');
  });

  it('disables the button while the request is in flight', async () => {
    let finish: (value: LoginResult) => void = () => undefined;
    const client = {
      login: vi.fn(() => new Promise<LoginResult>((resolve) => (finish = resolve))),
    } as unknown as AuthClient;
    render(<LoginForm client={client} />);
    await submit();
    expect(screen.getByRole('button', { name: 'Ingresando…' })).toBeDisabled();
    finish({ kind: 'invalid' });
    expect(await screen.findByRole('button', { name: 'Ingresar' })).toBeEnabled();
  });
});
