'use client';

import { ArrowRight, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useCallback } from 'react';

import { CdcDisplay } from '../../design-system/components/cdc-display';
import { MoneyPYG } from '../../design-system/components/money-pyg';
import { StatusBadge } from '../../design-system/components/status-badge';
import {
  documentsClient,
  type DocumentItem,
  type DocumentKind,
  type DocumentsClient,
} from '../documents/documents-client';
import { kindLabel } from '../documents/format';
import { useRemote } from '../documents/use-remote';

const RECENT_COUNT = 5;

const TYPE_CHIP: Record<DocumentKind, string> = {
  FE: 'bg-primary-fixed text-primary',
  NCE: 'bg-secondary-fixed text-on-secondary-fixed',
  NDE: 'bg-secondary-fixed text-on-secondary-fixed',
  AFE: 'bg-surface-container text-on-surface',
};
const NEUTRAL_CHIP = 'bg-surface-container text-on-surface';

const HEAD = 'px-4 py-3';

function Row({ doc }: { doc: DocumentItem }) {
  return (
    <tr className="transition-colors hover:bg-surface-container-low/60">
      <td className="px-4 py-3.5 font-semibold text-on-surface">
        <div className="flex items-center gap-2">
          <span
            className={`rounded px-1.5 py-0.5 font-code-sm text-code-sm font-bold ${doc.type ? TYPE_CHIP[doc.type] : NEUTRAL_CHIP}`}
          >
            {kindLabel(doc.type)}
          </span>
          <span>{doc.number}</span>
        </div>
      </td>
      <td className="px-4 py-3.5">
        <div className="flex flex-col">
          <span className="font-semibold text-on-surface">{doc.receiverName}</span>
          {doc.receiverRuc && (
            <span className="font-code-sm text-code-sm text-outline">{`RUC: ${doc.receiverRuc}`}</span>
          )}
        </div>
      </td>
      <td className="px-4 py-3.5">
        <CdcDisplay value={doc.cdc} variant="truncated" />
      </td>
      <td className="px-4 py-3.5 text-right">
        {doc.currency === 'PYG' ? (
          <MoneyPYG
            amount={Number(doc.total)}
            className="font-headline-md text-headline-md font-semibold text-on-surface"
          />
        ) : (
          <span className="font-headline-md text-headline-md font-semibold text-on-surface">{`${doc.total} ${doc.currency}`}</span>
        )}
      </td>
      <td className="px-4 py-3.5 text-center">
        <StatusBadge status={doc.status} />
      </td>
    </tr>
  );
}

/** The five newest documents of the active company, from the documents API. */
export function RecentDocuments({ client = documentsClient }: { client?: DocumentsClient }) {
  const load = useCallback(() => client.list({ page: 1, pageSize: RECENT_COUNT }), [client]);
  const { state, retry } = useRemote(load);
  const items = state?.kind === 'ok' ? state.page.items : undefined;

  return (
    <section
      aria-labelledby="recent-documents-title"
      className="flex flex-col rounded-xl bg-surface-container-lowest p-space-lg shadow-sm"
    >
      <div className="flex flex-col gap-space-sm pb-space-md md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col">
          <div className="flex items-center gap-space-xs">
            <h2
              id="recent-documents-title"
              className="font-headline-md text-headline-md text-on-surface"
            >
              Comprobantes Electrónicos Recientes
            </h2>
            <span className="rounded-full bg-surface-container px-2 py-0.5 font-code-sm text-code-sm font-bold text-on-surface-variant">
              {`Últimos ${String(RECENT_COUNT)}`}
            </span>
          </div>
          <span className="font-body-sm text-body-sm text-outline">
            Transmisión instantánea con Código de Control (CDC) de 44 dígitos
          </span>
        </div>
        <Link
          href="/comprobantes"
          className="flex items-center gap-1 rounded-lg bg-primary-container px-space-md py-1.5 font-label-sm text-label-sm font-semibold text-on-primary shadow-sm transition-all hover:bg-primary"
        >
          <span>Ver todos</span>
          <ArrowRight aria-hidden="true" className="size-4" />
        </Link>
      </div>

      {state === undefined && (
        <p
          role="status"
          aria-label="Cargando comprobantes recientes"
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
            className="inline-flex items-center gap-2 rounded-lg bg-surface-container-low px-space-md py-1.5 font-label-sm text-label-sm font-semibold text-on-surface"
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            Reintentar
          </button>
        </div>
      )}
      {items?.length === 0 && (
        <p className="font-body-md text-body-md text-on-surface-variant">
          Todavía no emitiste comprobantes.
        </p>
      )}
      {items && items.length > 0 && (
        <div
          role="region"
          aria-label="Tabla de comprobantes recientes"
          tabIndex={0}
          className="-mx-space-lg overflow-x-auto px-space-lg"
        >
          <table
            aria-labelledby="recent-documents-title"
            className="w-full border-collapse text-left"
          >
            <thead>
              <tr className="bg-surface-container-low font-label-sm text-label-sm tracking-wider text-outline uppercase">
                <th scope="col" className={`rounded-l-lg ${HEAD}`}>
                  Tipo &amp; Número
                </th>
                <th scope="col" className={HEAD}>
                  Cliente / Receptor
                </th>
                <th scope="col" className={HEAD}>
                  CDC (Identificador SIFEN)
                </th>
                <th scope="col" className={`${HEAD} text-right`}>
                  Monto Total
                </th>
                <th scope="col" className={`rounded-r-lg ${HEAD} text-center`}>
                  Estado DNIT
                </th>
              </tr>
            </thead>
            <tbody className="font-body-sm text-body-sm">
              {items.map((doc) => (
                <Row key={doc.id} doc={doc} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
