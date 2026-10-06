'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

import type { AuthClient } from './auth-client';
import { BUTTON_CLASS } from './auth-card';
import { authClient } from './default-client';

type State = 'loading' | 'ready' | 'unavailable';

/**
 * Client guard of the portal pages: asks the API who the user is (refreshing once if the access token expired)
 * and renders the content only for a session with an active tenant. No session goes to /login, a session without
 * an active tenant goes to the tenant picker.
 */
export function SessionGate({
  children,
  client = authClient,
}: {
  children: ReactNode;
  client?: AuthClient;
}) {
  const router = useRouter();
  const [state, setState] = useState<State>('loading');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    void client.me().then((result) => {
      if (!active) return;
      if (result.kind === 'unauthenticated') router.replace('/login');
      else if (result.kind !== 'ok') setState('unavailable');
      else if (result.session.activeTenant) setState('ready');
      else router.replace('/seleccionar-empresa');
    });
    return () => {
      active = false;
    };
  }, [client, router, attempt]);

  if (state === 'ready') return children;
  if (state === 'unavailable') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-space-md bg-surface p-space-lg">
        <p role="alert" className="font-body-md text-body-md text-on-surface">
          No pudimos verificar tu sesión. Revisá tu conexión e intentá de nuevo.
        </p>
        <button
          type="button"
          className={`${BUTTON_CLASS} max-w-xs`}
          onClick={() => {
            setState('loading');
            setAttempt((n) => n + 1);
          }}
        >
          Reintentar
        </button>
      </div>
    );
  }
  return (
    <p
      role="status"
      className="flex min-h-screen items-center justify-center bg-surface font-body-md text-body-md text-on-surface-variant"
    >
      Verificando sesión…
    </p>
  );
}
