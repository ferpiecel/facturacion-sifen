'use client';

import { RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { DocumentsDetail } from './documents-detail';
import { DocumentsFilters } from './documents-filters';
import { DocumentsPagination } from './documents-pagination';
import { DocumentsRow } from './documents-row';
import { filterDocuments, NO_FILTERS, type Filters } from './filters';
import { SAMPLE_DOCUMENTS_PAGE as PAGE, type DocumentKind } from './sample-documents';

const TABS: readonly {
  kind: DocumentKind | '';
  label: string;
  counted: readonly DocumentKind[];
}[] = [
  { kind: '', label: 'Todos', counted: ['FE', 'NCE', 'NDE', 'AFE'] },
  { kind: 'FE', label: 'Facturas', counted: ['FE'] },
  { kind: 'NCE', label: 'Notas de Crédito', counted: ['NCE'] },
  { kind: 'AFE', label: 'Autofacturas', counted: ['AFE'] },
];

const integer = (value: number) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const BULK =
  'rounded bg-surface-container-lowest px-2 py-1 font-label-sm text-label-sm font-semibold text-on-surface hover:bg-surface-container-high disabled:opacity-40';

/** Type tabs, bulk bar and master list of the Stitch explorer (left column). */
export function DocumentsBrowser() {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [activeId, setActiveId] = useState(PAGE.items[0]?.documentId);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const rows = filterDocuments(PAGE.items, filters);
  const current =
    rows.find((doc) => doc.documentId === activeId && doc.status === 'aprobado') ??
    rows.find((doc) => doc.status === 'aprobado');
  const chosen = rows.filter(({ documentId }) => selected.has(documentId)).length;

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (!next.delete(id)) next.add(id);
    setSelected(next);
  };

  return (
    <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-12">
      <DocumentsFilters
        filters={filters}
        onChange={(patch) => {
          setFilters({ ...filters, ...patch });
        }}
      />
      <div className="overflow-hidden rounded-xl bg-surface-container-lowest shadow-sm xl:col-span-7">
        <div className="flex items-center justify-between bg-surface-container-low px-4 pt-3">
          <div role="group" aria-label="Tipo de comprobante" className="flex items-center gap-1">
            {TABS.map(({ kind: tabKind, label, counted }) => {
              const active = tabKind === filters.kind;
              return (
                <button
                  key={label}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setFilters({ ...filters, kind: tabKind });
                  }}
                  className={`flex items-center gap-1.5 px-3.5 py-2 font-body-sm text-body-sm transition-colors ${
                    active
                      ? 'rounded-t-lg bg-surface-container-lowest font-semibold text-primary shadow-sm'
                      : 'font-medium text-on-surface-variant hover:text-on-surface'
                  }`}
                >
                  <span>{label}</span>
                  <span
                    className={`rounded-full px-1.5 font-code-sm text-code-sm ${
                      active
                        ? 'bg-primary/10 text-primary'
                        : 'bg-surface-container-high text-on-surface-variant'
                    }`}
                  >
                    {integer(counted.reduce((sum, k) => sum + PAGE.countsByKind[k], 0))}
                  </span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            aria-label="Actualizar datos"
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
                setSelected(
                  chosen === rows.length ? new Set() : new Set(rows.map((r) => r.documentId)),
                );
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
        {rows.length === 0 ? (
          <p className="p-6 text-center font-body-sm text-body-sm text-on-surface-variant">
            No hay comprobantes para los filtros aplicados.
          </p>
        ) : (
          <ul aria-label="Comprobantes" className="divide-y divide-surface-container-low">
            {rows.map((doc) => (
              <DocumentsRow
                key={doc.documentId}
                doc={doc}
                selected={selected.has(doc.documentId)}
                current={doc === current}
                onOpen={() => {
                  setActiveId(doc.documentId);
                }}
                onToggle={() => {
                  toggle(doc.documentId);
                }}
              />
            ))}
          </ul>
        )}
        <DocumentsPagination
          shown={rows.length}
          total={rows.length === PAGE.items.length ? PAGE.total : rows.length}
          page={PAGE.page}
          pageSize={PAGE.pageSize}
        />
      </div>
      <div className="xl:col-span-5">
        <DocumentsDetail doc={current} />
      </div>
    </div>
  );
}
