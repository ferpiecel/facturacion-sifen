import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthClient, SelectTenantResult, TenantsResult } from './auth-client';
import { TenantPicker } from './tenant-picker';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: replace, replace }) }));

const A = { tenantId: 't1', tenantName: 'Acme S.A.', role: 'owner' };
const B = { tenantId: 't2', tenantName: 'Beta SRL', role: 'lector' };

function setup(tenants: TenantsResult, select: SelectTenantResult = { kind: 'ok' }) {
  const client = {
    tenants: vi.fn(() => Promise.resolve(tenants)),
    selectTenant: vi.fn(() => Promise.resolve(select)),
  } as unknown as AuthClient;
  render(<TenantPicker client={client} />);
  return client;
}

describe('TenantPicker', () => {
  beforeEach(() => replace.mockClear());

  it('lists the tenants with their role as a named group of buttons', async () => {
    setup({ kind: 'ok', tenants: [A, B] });
    const group = await screen.findByRole('group', { name: 'Empresas disponibles' });
    expect(group).toHaveTextContent('Acme S.A.');
    expect(group).toHaveTextContent('Propietario');
    expect(group).toHaveTextContent('Beta SRL');
    expect(group).toHaveTextContent('Lector');
  });

  it('selects the chosen tenant and enters the panel', async () => {
    const client = setup({ kind: 'ok', tenants: [A, B] });
    await userEvent.setup().click(await screen.findByRole('button', { name: /Beta SRL/ }));
    expect(client.selectTenant).toHaveBeenCalledWith('t2');
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
  });

  it('skips the picker for a single tenant', async () => {
    const client = setup({ kind: 'ok', tenants: [A] });
    await waitFor(() => expect(client.selectTenant).toHaveBeenCalledWith('t1'));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
  });

  it('explains that an account without tenants needs an administrator', async () => {
    setup({ kind: 'ok', tenants: [] });
    expect(await screen.findByRole('alert')).toHaveTextContent('no tiene empresas');
  });

  it('sends an expired session to the login', async () => {
    setup({ kind: 'unauthenticated' });
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
  });

  it('announces a tenant that can no longer be used and stays on the picker', async () => {
    setup({ kind: 'ok', tenants: [A, B] }, { kind: 'forbidden' });
    await userEvent.setup().click(await screen.findByRole('button', { name: /Acme/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('ya no está disponible');
    expect(replace).not.toHaveBeenCalled();
  });

  it('announces an unavailable API when listing', async () => {
    setup({ kind: 'unavailable' });
    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos cargar');
  });

  it('sends an expired session to the login when selecting', async () => {
    setup({ kind: 'ok', tenants: [A, B] }, { kind: 'unauthenticated' });
    await userEvent.setup().click(await screen.findByRole('button', { name: /Acme/ }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
  });
});
