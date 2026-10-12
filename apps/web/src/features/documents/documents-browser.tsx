'use client';

import { RefreshCw } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import {
  documentsClient,
  type DocumentKind,
  type DocumentsClient,
  type DocumentsQuery,
} from './documents-client';
import { DocumentsDetail } from './documents-detail';
import { DocumentsPagination } from './documents-pagination';
import { DocumentsRow } from './documents-row';
import { useRemote } from './use-remote';

const TABS: readonly { type: DocumentKind | ''; label: string }[] = [
  { type: '', label: 'Todos' },
  { type: 'FE', label: 'Facturas' },
  { type: 'NCE', label: 'Notas de Crédito' },
  { type: 'AFE', label: 'Autofacturas' },
];

const BULK =
  'rounded bg-surface-container-lowest px-2 py-1 font-label-sm text-label-sm font-semibold text-on-surface hover:bg-surface-container-high disabled:opacity-40';

/** Type tabs, bulk bar and master list of the Stitch explorer (left column). */
export function DocumentsBrowser({ client = documentsClient }: { client?: DocumentsClient }) {
  const [type, setType] = useState<DocumentKind | ''>('');
  const [activeId, setActiveId] = useState<string>();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const query = useMemo<DocumentsQuery>(() => ({ type }), [type]);
  const load = useCallback(() => client.list(query), [client, query]);
  const { state, retry } = useRemote(load);
  const page = state?.kind === 'ok' ? state.page : undefined;
  const rows = page?.items ?? [];
  const current = rows.find(({ id }) => id === activeId) ?? rows.at(0);
  const chosen = rows.filter(({ id }) => selected.has(id)).length;

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (!next.delete(id)) next.add(id);
    setSelected(next);
  };

  return (
    <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-12">
      <div className="overflow-hidden rounded-xl bg-surface-container-lowest shadow-sm xl:col-span-7">
        <div className="flex items-center justify-between bg-surface-container-low px-4 pt-3">
          <div role="group" aria-label="Tipo de comprobante" className="flex items-center gap-1">
            {TABS.map(({ type: tabType, label }) => {
              const active = tabType === type;
              return (
                <button
                  key={label}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setType(tabType);
                  }}
                  className={`flex items-center gap-1.5 px-3.5 py-2 font-body-sm text-body-sm transition-colors ${
                    active
                      ? 'rounded-t-lg bg-surface-container-lowest font-semibold text-primary shadow-sm'
                      : 'font-medium text-on-surface-variant hover:text-on-surface'
                  }`}
                >
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            aria-label="Actualizar datos"
            onClick={retry}
            className="mb-1 rounded p-1 text-outline transition-colors hover:bg-surface-container-high hover:text-on-surface"
          >
            <RefreshCw aria-hidden="true" className="size-[18px]" />
          </button>
        </div>
        <div className="flex items-center justify-between bg-surface-container px-4 py-2 font-label-md text-label-md text-on-surface">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              aria-label="Seleccionar todos los comprobantes"
              checked={rows.length > 0 && chosen === rows.length}
              onChange={() => {
                setSelected(chosen === rows.length ? new Set() : new Set(rows.map(({ id }) => id)));
              }}
              className="size-4 rounded accent-primary"
            />
            <span aria-live="polite">{`Seleccionados: ${String(chosen)} ${chosen === 1 ? 'comprobante' : 'comprobantes'}`}</span>
          </label>
          <div className="flex items-center gap-2">
            <button type="button" disabled={chosen === 0} className={BULK}>
              Reenviar KuDE por email
            </button>
            <button type="button" disabled={chosen === 0} className={BULK}>
              Descargar XML Zip
            </button>
          </div>
        </div>
        {!state ? (
          <p
            role="status"
            aria-label="Cargando comprobantes"
            className="p-6 text-center font-body-sm text-body-sm text-on-surface-variant"
          >
            Cargando comprobantes…
          </p>
        ) : !page ? (
          <p
            role="alert"
            className="p-6 text-center font-body-sm text-body-sm text-on-surface-variant"
          >
            No pudimos cargar los comprobantes.{' '}
            <button
              type="button"
              onClick={retry}
              className="font-semibold text-primary hover:underline"
            >
              Reintentar
            </button>
          </p>
        ) : rows.length === 0 ? (
          <p className="p-6 text-center font-body-sm text-body-sm text-on-surface-variant">
            No hay comprobantes para los filtros aplicados.
          </p>
        ) : (
          <ul aria-label="Comprobantes" className="divide-y divide-surface-container-low">
            {rows.map((doc) => (
              <DocumentsRow
                key={doc.id}
                doc={doc}
                selected={selected.has(doc.id)}
                current={doc === current}
                onOpen={() => {
                  setActiveId(doc.id);
                }}
                onToggle={() => {
                  toggle(doc.id);
                }}
              />
            ))}
          </ul>
        )}
        {page && (
          <DocumentsPagination
            shown={rows.length}
            total={page.total}
            page={page.page}
            pageSize={page.pageSize}
          />
        )}
      </div>
      <div className="xl:col-span-5">
        <DocumentsDetail documentId={current?.id} client={client} />
      </div>
    </div>
  );
}
