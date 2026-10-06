'use client';

import { LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';

import type { AuthClient } from './auth-client';
import { authClient } from './default-client';

export function LogoutButton({ client = authClient }: { client?: AuthClient }) {
  const router = useRouter();
  return (
    <button
      type="button"
      aria-label="Cerrar sesión"
      onClick={() => {
        void client.logout().then(() => {
          router.replace('/login');
        });
      }}
      className="p-1 text-outline transition-colors hover:text-error"
    >
      <LogOut aria-hidden="true" className="size-[18px]" />
    </button>
  );
}
