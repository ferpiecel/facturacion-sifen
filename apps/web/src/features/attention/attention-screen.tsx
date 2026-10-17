'use client';

import { ChevronRight, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useCallback } from 'react';

import { CdcDisplay } from '../../design-system/components/cdc-display';
import { MoneyPYG } from '../../design-system/components/money-pyg';
import { StatusBadge } from '../../design-system/components/status-badge';
import type { AuthClient } from '../auth/auth-client';
import { authClient } from '../auth/default-client';
import { formatIssuedAt, kindLabel } from '../documents/format';
import { useRemote } from '../documents/use-remote';
import {
  attentionClient,
  type AttentionClient,
  type AttentionItem,
  type AttentionReason,
} from './attention-client';

/** Roles that may cancel, void, correct and nominate (PO decision); `lector` only reads. */
const CORRECTIVE_ROLES = new Set(['owner', 'admin', 'emisor']);

const REASONS: Record<AttentionReason, { label: string; tone: string }> = {
  overdue: { label: 'Plazo de 72 h vencido', tone: 'bg-error-container text-on-error-container' },
  held: { label: 'Retenido', tone: 'bg-error-container text-on-error-container' },
  rejected: { label: 'Rechazado por SIFEN', tone: 'bg-error-container text-on-error-container' },
  due_soon: { label: 'Por vencer', tone: 'bg-test-environment text-on-test-environment' },
};

const PLACEHOLDER =
  'rounded-lg bg-surface-container px-3 py-1.5 font-label-sm text-label-sm font-semibold text-outline disabled:cursor-not-allowed';

function deadlineText(item: AttentionItem): string {
  if (item.deadline === null || item.hoursRemaining === null) return 'Sin firmar';
  if (item.reasons.includes('overdue')) return `Venció ${formatIssuedAt(item.deadline)}`;
  return `Vence en ${String(item.hoursRemaining).replace('.', ',')} h`;
}

/** The corrective flows arrive with the cancellation and voiding stories (E8); until then they are placeholders. */
function CorrectiveActions({ item }: { item: AttentionItem }) {
  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <div className="flex gap-space-xs">
        <button type="button" disabled title="Disponible próximamente" className={PLACEHOLDER}>
          {`Corregir ${item.number}`}
        </button>
        <button type="button" disabled title="Disponible próximamente" className={PLACEHOLDER}>
          {`Inutilizar ${item.number}`}
        </button>
      </div>
      <span className="font-label-sm text-label-sm text-outline">Disponible próximamente</span>
    </div>
  );
}

function Card({ item, canAct }: { item: AttentionItem; canAct: boolean }) {
  return (
    <li className="flex flex-col gap-space-sm rounded-xl bg-surface-container-lowest p-space-md shadow-sm sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-headline-md text-headline-md font-bold text-on-surface">{`${kindLabel(item.type)} ${item.number}`}</span>
          <StatusBadge status={item.status} />
          {item.reasons.map((reason) => (
            <span
              key={reason}
              className={`rounded-full px-2.5 py-1 font-label-sm text-label-sm font-semibold ${REASONS[reason].tone}`}
            >
              {REASONS[reason].label}
            </span>
          ))}
        </div>
        <span className="font-body-sm text-body-sm text-on-surface">{item.receiverName}</span>
        <CdcDisplay value={item.cdc} variant="truncated" />
        {item.rejectionReason && (
          <span className="font-body-sm text-body-sm text-error">{item.rejectionReason}</span>
        )}
        {item.hold && (
          <code className="font-code-sm text-code-sm text-on-surface-variant">{item.hold}</code>
        )}
      </div>
      <div className="flex flex-col gap-space-xs sm:items-end">
        <span className="font-code-sm text-code-sm font-semibold text-on-surface">
          {deadlineText(item)}
        </span>
        {item.currency === 'PYG' ? (
          <MoneyPYG amount={Number(item.total)} className="font-body-md text-on-surface" />
        ) : (
          <span className="font-body-md text-on-surface">{`${item.total} ${item.currency}`}</span>
        )}
        {canAct && <CorrectiveActions item={item} />}
      </div>
    </li>
  );
}

/** HU-E12-04: rejected, held and soon-due or overdue documents of the active company. */
export function AttentionScreen({
  client = attentionClient,
  auth = authClient,
}: {
  client?: AttentionClient;
  auth?: AuthClient;
}) {
  const load = useCallback(() => client.get(), [client]);
  const loadMe = useCallback(() => auth.me(), [auth]);
  const { state, retry } = useRemote(load);
  const { state: me } = useRemote(loadMe);
  const role = me?.kind === 'ok' ? me.session.activeTenant?.role : undefined;
  const canAct = role !== undefined && CORRECTIVE_ROLES.has(role);
  const page = state?.kind === 'ok' ? state.page : undefined;

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-1.5">
        <nav
          aria-label="Ruta de navegación"
          className="flex items-center gap-2 font-label-md text-label-md text-on-surface-variant"
        >
          <Link href="/" className="transition-colors hover:text-primary">
            Inicio
          </Link>
          <ChevronRight aria-hidden="true" className="size-3.5 text-outline" />
          <span aria-current="page" className="font-semibold text-on-surface">
            Acción requerida
          </span>
        </nav>
        <h1 className="font-headline-xl text-headline-xl tracking-tight text-on-surface">
          Comprobantes que necesitan acción
        </h1>
        <p className="font-body-md text-body-md text-on-surface-variant">
          Rechazados, retenidos y pendientes cerca del plazo de 72 h para transmitirse a SIFEN.
        </p>
        {page && (
          <span className="font-label-md text-label-md text-outline">
            {`${String(page.total)} comprobante${page.total === 1 ? '' : 's'}`}
          </span>
        )}
      </header>

      {state === undefined && (
        <p
          role="status"
          aria-label="Cargando comprobantes"
          className="font-body-md text-body-md text-on-surface-variant"
        >
          Cargando…
        </p>
      )}
      {state && state.kind !== 'ok' && state.kind !== 'unauthenticated' && (
        <div role="alert" className="flex flex-col items-start gap-space-sm">
          <p className="font-body-md text-body-md text-on-surface">
            No pudimos cargar los comprobantes. Intentá de nuevo.
          </p>
          <button
            type="button"
            onClick={retry}
            className="inline-flex items-center gap-2 rounded-lg bg-primary-container px-space-md py-2 font-label-md text-label-md font-semibold text-on-primary"
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            Reintentar
          </button>
        </div>
      )}
      {page && page.items.length === 0 && (
        <p className="rounded-xl bg-surface-container-lowest p-space-lg font-body-md text-body-md text-on-surface-variant shadow-sm">
          No hay comprobantes que necesiten acción.
        </p>
      )}
      {page && page.items.length > 0 && (
        <>
          {page.truncated && (
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              {`Mostrando los ${String(page.items.length)} más urgentes de ${String(page.total)}.`}
            </p>
          )}
          <ul aria-label="Comprobantes que necesitan acción" className="flex flex-col gap-space-sm">
            {page.items.map((item) => (
              <Card key={item.id} item={item} canAct={canAct} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
