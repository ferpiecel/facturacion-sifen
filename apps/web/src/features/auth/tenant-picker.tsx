'use client';

import { Store } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import type { AuthClient, Tenant } from './auth-client';
import { FormError } from './auth-card';
import { authClient } from './default-client';

const ROLES: Record<string, string> = {
  owner: 'Propietario',
  admin: 'Administrador',
  emisor: 'Emisor',
  lector: 'Lector',
};

/**
 * Active-tenant choice. It is only shown when the user belongs to several tenants: a single one is selected
 * automatically. The API re-checks the membership on every request, so a stale list just yields `forbidden`.
 */
export function TenantPicker({ client = authClient }: { client?: AuthClient }) {
  const router = useRouter();
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(tenantId: string) {
    setError(null);
    const result = await client.selectTenant(tenantId);
    if (result.kind === 'ok') router.replace('/');
    else if (result.kind === 'unauthenticated') router.replace('/login');
    else if (result.kind === 'forbidden')
      setError('Esa empresa ya no está disponible para tu usuario.');
    else setError('No pudimos seleccionar la empresa. Intentá de nuevo.');
  }

  useEffect(() => {
    let active = true;
    void client.tenants().then((result) => {
      if (!active) return;
      if (result.kind === 'unauthenticated') router.replace('/login');
      else if (result.kind === 'unavailable')
        setError('No pudimos cargar tus empresas. Intentá de nuevo.');
      else if (result.tenants.length === 0)
        setError(
          'Tu cuenta no tiene empresas asignadas. Pedile a un administrador que te agregue.',
        );
      else if (result.tenants.length === 1) void choose(result.tenants[0]?.tenantId ?? '');
      else setTenants(result.tenants);
    });
    return () => {
      active = false;
    };
    // `choose` only closes over `client` and `router`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, router]);

  return (
    <div className="flex flex-col gap-space-md">
      <FormError message={error} />
      {tenants && (
        <div role="group" aria-label="Empresas disponibles" className="flex flex-col gap-space-sm">
          {tenants.map((tenant) => (
            <button
              key={tenant.tenantId}
              type="button"
              onClick={() => void choose(tenant.tenantId)}
              className="flex items-center gap-space-sm rounded-lg border border-outline-variant px-space-md py-space-sm text-left transition-colors hover:bg-surface-container-low focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <Store aria-hidden="true" className="size-5 text-primary" />
              <span className="flex flex-col">
                <span className="font-body-md text-body-md font-semibold text-on-surface">
                  {tenant.tenantName}
                </span>
                <span className="font-label-sm text-label-sm text-outline">
                  {ROLES[tenant.role] ?? tenant.role}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
