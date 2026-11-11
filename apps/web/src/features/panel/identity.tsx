'use client';

import { createContext, useCallback, useContext, type ReactNode } from 'react';

import type { AuthClient } from '../auth/auth-client';
import { authClient } from '../auth/default-client';
import { useRemote } from '../documents/use-remote';

const ROLE_LABELS: Record<string, string> = {
  owner: 'Propietario',
  admin: 'Administrador',
  emisor: 'Emisor',
  lector: 'Lector',
};

export interface Identity {
  /** `loading` until the session answers; `unavailable` when it cannot be read. */
  status: 'loading' | 'ready' | 'unavailable';
  companyName?: string;
  /** Spanish label of the user's role in the active company. */
  roleLabel?: string;
}

const IdentityContext = createContext<Identity>({ status: 'loading' });

export const useIdentity = (): Identity => useContext(IdentityContext);

/** Reads who is signed in and which company is active once, for the whole shell (`/auth/me` + `/auth/tenants`). */
export function IdentityProvider({
  auth = authClient,
  children,
}: {
  auth?: AuthClient;
  children: ReactNode;
}) {
  const loadMe = useCallback(() => auth.me(), [auth]);
  const loadTenants = useCallback(() => auth.tenants(), [auth]);
  const { state: me } = useRemote(loadMe);
  const { state: tenants } = useRemote(loadTenants);

  const active = me?.kind === 'ok' ? me.session.activeTenant : null;
  let identity: Identity = { status: 'loading' };
  if (me !== undefined && tenants !== undefined) {
    identity = { status: 'unavailable' };
    if (active && tenants.kind === 'ok') {
      identity = {
        status: 'ready',
        companyName: tenants.tenants.find((t) => t.tenantId === active.tenantId)?.tenantName,
        roleLabel: ROLE_LABELS[active.role],
      };
    }
  }
  return <IdentityContext.Provider value={identity}>{children}</IdentityContext.Provider>;
}

export function ActiveCompanyName() {
  const { status, companyName } = useIdentity();
  if (status === 'loading') return 'Cargando…';
  return companyName ?? 'Empresa no disponible';
}

export function UserRoleLabel() {
  const { roleLabel } = useIdentity();
  return roleLabel ?? '';
}
