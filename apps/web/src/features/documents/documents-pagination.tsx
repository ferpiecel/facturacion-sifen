import { ChevronLeft, ChevronRight } from 'lucide-react';

interface DocumentsPaginationProps {
  shown: number;
  total: number;
  page: number;
  pageSize: number;
}

const integer = (value: number) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const PAGE_SIZES = [5, 10, 25, 50];
const ARROW =
  'flex size-8 items-center justify-center rounded-lg bg-surface-container-lowest text-on-surface shadow-sm disabled:opacity-40';

/** Pagination footer; inert until `GET /v1/documents` supports paging. */
export function DocumentsPagination({ shown, total, page, pageSize }: DocumentsPaginationProps) {
  const last = Math.max(1, Math.ceil(total / pageSize));
  const pages = [...new Set([1, 2, 3, last].filter((n) => n <= last))];

  return (
    <nav
      aria-label="Paginación"
      className="flex flex-col items-center justify-between gap-3 bg-surface-container-low p-4 font-body-sm text-body-sm text-on-surface-variant sm:flex-row"
    >
      <div className="flex items-center gap-2">
        <span>{`Mostrando ${shown === 0 ? '0' : `1 - ${integer(shown)}`} de ${integer(total)} comprobantes`}</span>
        <span aria-hidden="true" className="text-outline">
          •
        </span>
        <label className="flex items-center gap-1">
          <span>Filas:</span>
          <select
            aria-label="Filas por página"
            defaultValue={pageSize}
            className="rounded bg-surface-container-lowest px-1.5 py-0.5 font-label-sm text-label-sm font-medium text-on-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex items-center gap-1">
        <button type="button" aria-label="Anterior" disabled={page === 1} className={ARROW}>
          <ChevronLeft aria-hidden="true" className="size-[18px]" />
        </button>
        {pages.map((n, index) => (
          <span key={n} className="flex items-center gap-1">
            {index > 0 && n - pages[index - 1] > 1 && (
              <span className="px-1 text-outline">...</span>
            )}
            <button
              type="button"
              aria-label={`Página ${String(n)}`}
              aria-current={n === page ? 'page' : undefined}
              className={`flex size-8 items-center justify-center rounded-lg ${
                n === page
                  ? 'bg-primary-container font-bold text-on-primary shadow-sm'
                  : 'bg-surface-container-lowest text-on-surface hover:bg-surface-container'
              }`}
            >
              {n}
            </button>
          </span>
        ))}
        <button type="button" aria-label="Siguiente" disabled={page === last} className={ARROW}>
          <ChevronRight aria-hidden="true" className="size-[18px]" />
        </button>
      </div>
    </nav>
  );
}
