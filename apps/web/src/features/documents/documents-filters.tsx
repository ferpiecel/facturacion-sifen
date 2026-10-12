import { ChevronDown, Search, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { appliedFilters, KIND_OPTIONS, NO_FILTERS, STATUS_OPTIONS, type Filters } from './filters';

const SELECT =
  'cursor-pointer appearance-none rounded-lg bg-surface-container-low px-3 py-2 pr-8 font-body-sm text-body-sm text-on-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-primary';

function Select({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="relative">
      <select
        aria-label={label}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className={SELECT}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-2.5 right-2.5 size-4 text-outline"
      />
    </div>
  );
}

interface DocumentsFiltersProps {
  filters: Filters;
  onChange: (patch: Partial<Filters>) => void;
}

const DATE =
  'rounded-lg bg-surface-container-low px-3 py-2 font-body-sm text-body-sm text-on-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-primary';

/** Search box, selects, date range and applied-filter chips of the Stitch explorer. */
export function DocumentsFilters({ filters, onChange }: DocumentsFiltersProps) {
  const chips = appliedFilters(filters);
  // The search text is sent on submit; an outside change (chip, "Limpiar filtros") resets the draft.
  const [draft, setDraft] = useState(filters.q);
  const [seen, setSeen] = useState(filters.q);
  if (seen !== filters.q) {
    setSeen(filters.q);
    setDraft(filters.q);
  }

  return (
    <section
      aria-label="Filtros"
      className="flex flex-col gap-3 rounded-xl bg-surface-container-lowest p-4 shadow-sm xl:col-span-12"
    >
      <div className="flex flex-col items-stretch gap-3 lg:flex-row lg:items-center">
        <form
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            onChange({ q: draft.trim() });
          }}
          className="flex flex-1 items-center gap-2 rounded-lg bg-surface-container-low px-3 py-2 text-on-surface focus-within:ring-2 focus-within:ring-primary"
        >
          <Search aria-hidden="true" className="size-5 text-outline" />
          <input
            type="search"
            aria-label="Filtrar el listado de comprobantes"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            placeholder="Buscar por CDC (44 dígitos), RUC emisor/receptor, N° de Factura o Razón Social..."
            className="w-full bg-transparent font-body-sm text-body-sm placeholder:text-outline focus:outline-none"
          />
        </form>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            label="Tipo de documento"
            value={filters.type}
            onChange={(type) => {
              onChange({ type: type as Filters['type'] });
            }}
          >
            <option value="">Todos los Documentos</option>
            {KIND_OPTIONS.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <Select
            label="Estado"
            value={filters.status}
            onChange={(status) => {
              onChange({ status });
            }}
          >
            <option value="">Todos los estados</option>
            {STATUS_OPTIONS.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          {(['from', 'to'] as const).map((key) => (
            <input
              key={key}
              type="date"
              aria-label={key === 'from' ? 'Desde' : 'Hasta'}
              value={filters[key]}
              onChange={(event) => {
                onChange({ [key]: event.target.value });
              }}
              className={DATE}
            />
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 font-body-sm text-body-sm">
        {chips.length > 0 ? (
          <div role="group" aria-label="Filtros aplicados" className="flex items-center gap-2">
            <span className="font-label-sm text-label-sm text-outline">Filtros aplicados:</span>
            {chips.map(({ key, label }) => (
              <span
                key={key}
                className="inline-flex items-center gap-1 rounded-full bg-surface-container-high px-2 py-0.5 font-label-sm text-label-sm text-on-surface"
              >
                {label}
                <button
                  type="button"
                  aria-label={`Quitar filtro ${label}`}
                  onClick={() => {
                    onChange({ [key]: NO_FILTERS[key] });
                  }}
                  className="hover:text-error"
                >
                  <X aria-hidden="true" className="size-3" />
                </button>
              </span>
            ))}
            <button
              type="button"
              onClick={() => {
                onChange(NO_FILTERS);
              }}
              className="ml-2 font-label-sm text-label-sm font-semibold text-primary hover:underline"
            >
              Limpiar filtros
            </button>
          </div>
        ) : (
          <span />
        )}
      </div>
    </section>
  );
}
