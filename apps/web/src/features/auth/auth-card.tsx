import Image from 'next/image';
import type { ReactNode } from 'react';

import { BRAND } from '../../design-system/brand';

interface AuthCardProps {
  title: string;
  description: string;
  children: ReactNode;
}

/**
 * Centered card for the pre-session screens. Stitch ("Portal Facturación SIFEN") has no login, MFA or tenant
 * picker screen, so this reuses the portal's tokens and logo (deviation recorded in odd/tasks/hu-e1-07-portal-login.md).
 */
export function AuthCard({ title, description, children }: AuthCardProps) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface px-space-md py-space-xl">
      <div className="w-full max-w-md rounded-xl bg-surface-container-lowest p-space-xl shadow-[0_1px_8px_rgba(0,0,0,0.06)]">
        <Image
          src={BRAND.logoSrc}
          alt={BRAND.name}
          width={220}
          height={50}
          className="mb-space-lg h-8 w-auto object-contain"
          priority
        />
        <h1 className="font-headline-lg text-headline-lg text-on-surface">{title}</h1>
        <p className="mt-space-xs mb-space-lg font-body-md text-body-md text-on-surface-variant">
          {description}
        </p>
        {children}
      </div>
    </main>
  );
}

export const FIELD_CLASS =
  'w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-space-md py-space-sm font-body-md text-body-md text-on-surface placeholder:text-outline focus:outline-none focus:ring-2 focus:ring-primary aria-[invalid=true]:border-error';

export const BUTTON_CLASS =
  'w-full rounded-lg bg-primary-container px-space-md py-space-sm font-body-md text-body-md font-semibold text-on-primary transition-colors hover:bg-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60';

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-lg bg-error-container px-space-md py-space-sm font-body-sm text-body-sm text-on-error-container"
    >
      {message}
    </p>
  );
}
