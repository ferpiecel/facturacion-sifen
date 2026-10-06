import {
  Bell,
  Building2,
  ChevronsUpDown,
  LayoutDashboard,
  ReceiptText,
  Search,
  Store,
  User,
} from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { BRAND } from '../../design-system/brand';
import {
  EnvironmentBanner,
  type Environment,
} from '../../design-system/components/environment-banner';
import { LogoutButton } from '../auth/logout-button';
import { SAMPLE_TENANT, SAMPLE_USER } from './sample-data';

const NAV = [
  { href: '/', label: 'Panel de Control', icon: LayoutDashboard },
  { href: '/comprobantes', label: 'Comprobantes y KuDE', icon: ReceiptText },
  { href: '/comercios', label: 'Mis Comercios', icon: Building2 },
] as const;

function Logo() {
  return (
    <Image
      src={BRAND.logoSrc}
      alt={BRAND.name}
      width={220}
      height={50}
      className="h-8 w-auto object-contain"
      priority
    />
  );
}

function Avatar() {
  return (
    <div
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary"
    >
      <User className="size-[18px] text-on-primary" />
    </div>
  );
}

function Sidebar({ activePath }: { activePath: string }) {
  return (
    <aside className="fixed top-0 left-0 z-50 flex h-full w-64 flex-col justify-between overflow-y-auto bg-surface-container-lowest shadow-[0_1px_8px_rgba(0,0,0,0.04)]">
      <div className="flex flex-col">
        <div className="flex h-16 items-center gap-space-sm px-space-md">
          <Logo />
        </div>
        <div className="px-space-md py-space-sm">
          <div className="flex items-center justify-between rounded-lg bg-surface-container-low p-space-sm">
            <div className="flex items-center gap-space-sm overflow-hidden">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary-container">
                <Store aria-hidden="true" className="size-4 text-on-primary" />
              </div>
              <div className="flex flex-col truncate">
                <span className="truncate font-label-sm text-label-sm text-outline">
                  EMPRESA ACTIVA
                </span>
                <span className="truncate font-body-sm text-body-sm font-semibold text-on-surface">
                  {SAMPLE_TENANT}
                </span>
              </div>
            </div>
            <ChevronsUpDown aria-hidden="true" className="size-[18px] text-outline" />
          </div>
        </div>
        <nav aria-label="Principal" className="mt-space-sm flex flex-col gap-1 px-space-md">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = href === activePath;
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={
                  active
                    ? 'flex items-center gap-space-sm rounded-lg bg-primary-container px-space-md py-space-sm font-semibold text-on-primary shadow-sm transition-all'
                    : 'flex items-center gap-space-sm rounded-lg px-space-md py-space-sm text-on-surface-variant transition-all hover:bg-surface-container-high hover:text-on-surface'
                }
              >
                <Icon aria-hidden="true" className="size-5" />
                <span className="flex-1 font-body-md text-body-md">{label}</span>
              </Link>
            );
          })}
        </nav>
      </div>
      <div className="flex flex-col gap-space-sm p-space-md">
        <div className="flex items-center justify-between rounded-lg p-space-xs transition-colors hover:bg-surface-container-low">
          <div className="flex items-center gap-space-sm">
            <Avatar />
            <div className="flex flex-col truncate">
              <span className="truncate font-body-sm text-body-sm font-semibold text-on-surface">
                {SAMPLE_USER.name}
              </span>
              <span className="truncate font-label-sm text-label-sm text-outline">
                {SAMPLE_USER.role}
              </span>
            </div>
          </div>
          <LogoutButton />
        </div>
      </div>
    </aside>
  );
}

function Topbar() {
  return (
    <header className="flex h-16 items-center justify-between bg-surface-container-lowest/90 px-space-lg shadow-[0_1px_8px_rgba(0,0,0,0.04)] backdrop-blur-xl">
      <div className="flex items-center gap-space-md">
        <Logo />
        <div className="flex items-center gap-space-xs rounded-full bg-surface-container-low px-space-sm py-1">
          <span
            aria-hidden="true"
            className="size-2 rounded-full bg-secondary motion-safe:animate-pulse"
          />
          <span className="font-code-sm text-code-sm font-semibold text-secondary">
            SIFEN: En línea
          </span>
          <span className="font-code-sm text-code-sm text-outline">120ms</span>
        </div>
      </div>
      <div className="mx-space-md max-w-md flex-1">
        <div className="flex items-center gap-space-xs rounded-lg bg-surface-container-low px-space-sm py-1.5 text-on-surface-variant focus-within:ring-2 focus-within:ring-primary">
          <Search aria-hidden="true" className="size-[18px] text-outline" />
          <input
            type="search"
            aria-label="Buscar comprobantes"
            placeholder="Buscar por CDC (44 dígitos), RUC o cliente..."
            className="w-full bg-transparent font-body-sm text-body-sm text-on-surface placeholder:text-outline focus:outline-none"
          />
          <kbd className="rounded bg-surface-container-lowest px-1.5 py-0.5 font-code-sm text-code-sm text-outline shadow-sm">
            ⌘K
          </kbd>
        </div>
      </div>
      <div className="flex items-center gap-space-sm">
        <button
          type="button"
          aria-label="Notificaciones"
          className="relative flex size-9 items-center justify-center rounded-lg text-on-surface-variant transition-colors hover:bg-surface-container-high"
        >
          <Bell aria-hidden="true" className="size-5" />
          <span
            aria-hidden="true"
            className="absolute top-2 right-2 size-2 rounded-full bg-error"
          />
        </button>
        <Avatar />
      </div>
    </header>
  );
}

interface PanelShellProps {
  environment: Environment;
  activePath: string;
  children?: ReactNode;
}

/** Sidebar + topbar frame of the Stitch "Panel de Control" screen. */
export function PanelShell({ environment, activePath, children }: PanelShellProps) {
  return (
    <>
      <Sidebar activePath={activePath} />
      <div className="pl-64">
        <div className="sticky top-0 z-40">
          <EnvironmentBanner environment={environment} />
          <Topbar />
        </div>
        <main className="min-h-screen w-full bg-surface">{children}</main>
      </div>
    </>
  );
}
