'use client';

import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';

import { StatusBadge } from '../../design-system/components/status-badge';
import { useRemote } from '../documents/use-remote';
import {
  RECEIVED_DOCUMENT_STATUSES,
  receptionClient,
  type ReceivedDocumentSummary,
  type ReceptionClient,
} from './reception-client';

const PAGE_SIZE = 20;

/** Filter labels, one per known status (exhaustive by type); a spec keeps them equal to the `StatusBadge` ones. */
const STATUS_LABELS: Record<(typeof RECEIVED_DOCUMENT_STATUSES)[number], string> = {
  received: 'Recibido',
  extracting: 'Extrayendo datos',
  extracted: 'Datos extraídos',
  needs_review: 'Requiere revisión',
  extraction_failed: 'Extracción fallida',
  confirmed: 'Confirmado',
};

const STATUS_OPTIONS: readonly { value: string; label: string }[] = [
  { value: '', label: 'Todos' },
  ...RECEIVED_DOCUMENT_STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] })),
];

const ARROW =
  'flex size-8 items-center justify-center rounded-lg bg-surface-container-lowest text-on-surface shadow-sm disabled:opacity-40';
const NOTE = 'p-6 text-center font-body-sm text-body-sm text-on-surface-variant';

/** `2026-10-02` to `02/10/2026`; `-` without a date. */
const formatDay = (day: string | null) => (day ? day.split('-').reverse().join('/') : '-');

function ReceivedRow({ doc }: { doc: ReceivedDocumentSummary }) {
  return (
    <li className="hover:bg-surface-container-low">
      <Link
        href={`/recibidos/${encodeURIComponent(doc.id)}`}
        className="flex flex-wrap items-center justify-between gap-3 p-4"
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-body-md text-body-md font-semibold text-on-surface">
            {doc.issuer.name ?? 'Emisor sin identificar'}
          </span>
          <span className="font-label-sm text-label-sm text-on-surface-variant">
            {doc.issuer.ruc ?? 'Sin RUC'}
          </span>
          <span className="font-label-sm text-label-sm text-on-surface-variant">
            {doc.document_number ?? 'Sin número'}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <span className="font-label-md text-label-md text-on-surface-variant">
            {formatDay(doc.issued_on)}
          </span>
          <span className="font-body-md text-body-md font-bold text-on-surface">
            {doc.total_amount === null ? '-' : `${doc.total_amount} ${doc.currency ?? ''}`.trim()}
          </span>
          {!doc.is_own_receiver && (
            <span className="rounded-full bg-error-container px-2 py-0.5 font-label-sm text-label-sm font-semibold text-on-error-container">
              Otro receptor
            </span>
          )}
          <StatusBadge status={doc.status} />
        </div>
      </Link>
    </li>
  );
}

/** Read-only list of the received documents of the tenant, with a status filter and cursor paging. */
export function ReceivedList({ client = receptionClient }: { client?: ReceptionClient }) {
  const [status, setStatus] = useState('');
  // Cursors of the visited pages; the last one is the current page (`undefined`: the first page).
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors[cursors.length - 1];
  const query = useMemo(
    () => ({
      ...(status && { status }),
      ...(cursor && { cursor }),
      limit: PAGE_SIZE,
    }),
    [status, cursor],
  );
  const load = useCallback(() => client.list(query), [client, query]);
  const { state, previous, retry } = useRemote(load);
  const shown = state ?? previous;
  const page = shown?.kind === 'ok' ? shown.page : undefined;
  const loading = state === undefined;

  return (
    <div className="overflow-hidden rounded-xl bg-surface-container-lowest shadow-sm">
      <div className="flex items-center justify-between bg-surface-container-low px-4 py-3">
        <label className="flex items-center gap-2 font-label-md text-label-md text-on-surface">
          <span>Estado</span>
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setCursors([undefined]);
            }}
            className="rounded bg-surface-container-lowest px-2 py-1 font-label-md text-label-md"
          >
            {STATUS_OPTIONS.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          aria-label="Actualizar datos"
          onClick={retry}
          className="rounded p-1 text-outline transition-colors hover:bg-surface-container-high hover:text-on-surface"
        >
          <RefreshCw aria-hidden="true" className="size-[18px]" />
        </button>
      </div>
      {!shown ? (
        <p role="status" aria-label="Cargando documentos recibidos" className={NOTE}>
          Cargando documentos recibidos…
        </p>
      ) : !page ? (
        <p role="alert" className={NOTE}>
          No pudimos cargar los documentos recibidos.{' '}
          <button
            type="button"
            onClick={retry}
            className="font-semibold text-primary hover:underline"
          >
            Reintentar
          </button>
        </p>
      ) : page.items.length === 0 ? (
        <p className={NOTE}>No hay documentos recibidos para mostrar.</p>
      ) : (
        <ul
          aria-label="Documentos recibidos"
          aria-busy={loading}
          className="divide-y divide-surface-container-low"
        >
          {page.items.map((doc) => (
            <ReceivedRow key={doc.id} doc={doc} />
          ))}
        </ul>
      )}
      <nav
        aria-label="Paginación"
        aria-busy={loading}
        className="flex items-center justify-end gap-1 bg-surface-container-low p-4"
      >
        <button
          type="button"
          aria-label="Anterior"
          disabled={cursors.length === 1 || loading}
          onClick={() => {
            setCursors(cursors.slice(0, -1));
          }}
          className={ARROW}
        >
          <ChevronLeft aria-hidden="true" className="size-[18px]" />
        </button>
        <button
          type="button"
          aria-label="Siguiente"
          disabled={!page?.next_cursor || loading}
          onClick={() => {
            if (page?.next_cursor) setCursors([...cursors, page.next_cursor]);
          }}
          className={ARROW}
        >
          <ChevronRight aria-hidden="true" className="size-[18px]" />
        </button>
      </nav>
    </div>
  );
}
