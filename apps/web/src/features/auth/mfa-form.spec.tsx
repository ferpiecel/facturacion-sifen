import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthClient, MfaResult } from './auth-client';
import { MfaForm } from './mfa-form';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: replace, replace }) }));

const A = { tenantId: 't1', tenantName: 'Acme', role: 'owner' };
const B = { tenantId: 't2', tenantName: 'Beta', role: 'lector' };

function setup(result: MfaResult) {
  const client = { verifyMfa: vi.fn(() => Promise.resolve(result)) } as unknown as AuthClient;
  render(<MfaForm client={client} />);
  return client;
}

describe('MfaForm', () => {
  beforeEach(() => replace.mockClear());

  it('asks for the 6-digit code first, focused, with the one-time-code hint', () => {
    setup({ kind: 'invalid' });
    const input = screen.getByLabelText('Código de 6 dígitos');
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('inputmode', 'numeric');
    expect(input).toHaveAttribute('autocomplete', 'one-time-code');
  });

  it('verifies the code and enters the panel when a single tenant is active', async () => {
    const client = setup({
      kind: 'ok',
      activeTenant: { tenantId: 't1', role: 'owner' },
      tenants: [A],
    });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Código de 6 dígitos'), '123 456');
    await user.click(screen.getByRole('button', { name: 'Verificar' }));
    expect(client.verifyMfa).toHaveBeenCalledWith('123456');
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/');
    });
  });

  it('goes to the tenant picker when the user belongs to several tenants', async () => {
    setup({ kind: 'ok', activeTenant: null, tenants: [A, B] });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Código de 6 dígitos'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verificar' }));
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/seleccionar-empresa');
    });
  });

  it('tells a user with no tenants that an administrator must assign one', async () => {
    setup({ kind: 'ok', activeTenant: null, tenants: [] });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Código de 6 dígitos'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verificar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no tiene empresas');
    expect(replace).not.toHaveBeenCalled();
  });

  it('rejects a malformed code without calling the API', async () => {
    const client = setup({ kind: 'invalid' });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Código de 6 dígitos'), '12ab');
    await user.click(screen.getByRole('button', { name: 'Verificar' }));
    expect(client.verifyMfa).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('6 dígitos');
  });

  it('switches to a recovery code and sends it as typed', async () => {
    const client = setup({
      kind: 'ok',
      activeTenant: { tenantId: 't1', role: 'owner' },
      tenants: [A],
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Usar un código de recuperación' }));
    const input = screen.getByLabelText('Código de recuperación');
    expect(input).toHaveFocus();
    await user.type(input, 'ABCD-EFGH-2345-6723');
    await user.click(screen.getByRole('button', { name: 'Verificar' }));
    expect(client.verifyMfa).toHaveBeenCalledWith('ABCD-EFGH-2345-6723');
  });

  it('can go back to the authenticator code', async () => {
    setup({ kind: 'invalid' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Usar un código de recuperación' }));
    await user.click(screen.getByRole('button', { name: 'Usar el código de la app' }));
    expect(screen.getByLabelText('Código de 6 dígitos')).toBeInTheDocument();
  });

  it.each([
    [{ kind: 'invalid' }, 'Código incorrecto o sesión vencida'],
    [{ kind: 'throttled' }, 'Demasiados intentos'],
    [{ kind: 'unavailable' }, 'No pudimos conectar'],
  ] as const)('announces a %o failure', async (result, text) => {
    setup(result);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Código de 6 dígitos'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verificar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(screen.getByLabelText('Código de 6 dígitos')).toHaveFocus();
  });

  it('links back to the login for an expired password step', () => {
    setup({ kind: 'invalid' });
    expect(screen.getByRole('link', { name: 'Volver a ingresar' })).toHaveAttribute(
      'href',
      '/login',
    );
  });
});
