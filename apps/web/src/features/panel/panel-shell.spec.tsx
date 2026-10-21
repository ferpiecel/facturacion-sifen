import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AuthClient, MeResult, TenantsResult } from '../auth/auth-client';
import { PanelShell } from './panel-shell';

const ME: MeResult = {
  kind: 'ok',
  session: { userId: 'u1', activeTenant: { tenantId: 't2', role: 'emisor' } },
};
const TENANTS: TenantsResult = {
  kind: 'ok',
  tenants: [
    { tenantId: 't1', tenantName: 'Otra S.A.', role: 'owner' },
    { tenantId: 't2', tenantName: 'Globex Paraguay S.A.', role: 'emisor' },
  ],
};

const fakeAuth = (me: MeResult = ME, tenants: TenantsResult = TENANTS) =>
  ({
    me: vi.fn(() => Promise.resolve(me)),
    tenants: vi.fn(() => Promise.resolve(tenants)),
  }) as unknown as AuthClient;

describe('PanelShell identity (company and role from the session)', () => {
  it('shows the active company and the role of the session', async () => {
    render(<PanelShell environment="test" activePath="/" auth={fakeAuth()} />);

    const aside = screen.getByRole('complementary');
    expect(await within(aside).findByText('Globex Paraguay S.A.')).toBeInTheDocument();
    expect(within(aside).getByText('Emisor')).toBeInTheDocument();
    expect(within(aside).queryByText('Otra S.A.')).not.toBeInTheDocument();
  });

  it('never shows the former sample company or user', async () => {
    render(<PanelShell environment="test" activePath="/" auth={fakeAuth()} />);

    await screen.findByText('Globex Paraguay S.A.');
    expect(screen.queryByText('Acme Paraguay S.A.')).not.toBeInTheDocument();
    expect(screen.queryByText('Carlos Bogado')).not.toBeInTheDocument();
    expect(screen.queryByText('Operador Certificado')).not.toBeInTheDocument();
  });

  it('does not invent a company or role when the session cannot be read', async () => {
    const auth = fakeAuth({ kind: 'unavailable' }, { kind: 'unavailable' });
    render(<PanelShell environment="test" activePath="/" auth={auth} />);

    const aside = screen.getByRole('complementary');
    expect(await within(aside).findByText('Empresa no disponible')).toBeInTheDocument();
    expect(within(aside).queryByText('Emisor')).not.toBeInTheDocument();
  });

  it('labels each role in Spanish', async () => {
    const labels: Record<string, string> = {
      owner: 'Propietario',
      admin: 'Administrador',
      emisor: 'Emisor',
      lector: 'Lector',
    };
    for (const [role, label] of Object.entries(labels)) {
      const me: MeResult = {
        kind: 'ok',
        session: { userId: 'u1', activeTenant: { tenantId: 't2', role } },
      };
      const { unmount } = render(
        <PanelShell environment="test" activePath="/" auth={fakeAuth(me)} />,
      );
      expect(await screen.findByText(label)).toBeInTheDocument();
      unmount();
    }
  });
});
