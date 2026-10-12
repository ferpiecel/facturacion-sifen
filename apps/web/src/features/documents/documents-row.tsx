import { Building2, EllipsisVertical, User } from 'lucide-react';

import { CdcDisplay } from '../../design-system/components/cdc-display';
import { MoneyPYG } from '../../design-system/components/money-pyg';
import { StatusBadge } from '../../design-system/components/status-badge';
import type { DocumentItem, DocumentKind } from './documents-client';
import { formatIssuedAt } from './format';

const KIND_PILL: Partial<Record<DocumentKind, string>> = {
  NCE: 'Nota de Crédito',
  NDE: 'Nota de Débito',
  AFE: 'Autofactura',
};

const ACTION =
  'flex items-center gap-1 rounded-md bg-surface-container px-2.5 py-1 font-label-sm text-label-sm font-semibold text-on-surface transition-colors hover:bg-surface-container-high';

/** Guaraníes use the Stitch money component (credit notes negative); other currencies show the API's decimal. */
function Total({ doc }: { doc: DocumentItem }) {
  const className = 'font-headline-md text-headline-md font-bold text-on-surface';
  if (doc.currency !== 'PYG') {
    return (
      <span className={`${className} whitespace-nowrap`}>{`${doc.total} ${doc.currency}`}</span>
    );
  }
  const amount = Number(doc.total);
  return <MoneyPYG amount={doc.type === 'NCE' ? -amount : amount} className={className} />;
}

/** One document of the Stitch master list. */
interface DocumentsRowProps {
  doc: DocumentItem;
  selected: boolean;
  current: boolean;
  onToggle: () => void;
  onOpen: () => void;
}

export function DocumentsRow({ doc, selected, current, onToggle, onOpen }: DocumentsRowProps) {
  const rejected = doc.status === 'rechazado';
  const Icon = doc.receiverRuc ? Building2 : User;

  return (
    <li
      aria-label={`${doc.type} ${doc.number}`}
      aria-current={current ? 'true' : undefined}
      className={`flex flex-col gap-2.5 p-4 transition-colors ${
        rejected
          ? 'bg-error-container/20 hover:bg-error-container/30'
          : selected || current
            ? 'bg-primary/5 hover:bg-primary/10'
            : 'hover:bg-surface-container-low'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            aria-label={`Seleccionar ${doc.type} ${doc.number}`}
            checked={selected}
            onChange={onToggle}
            className="size-4 cursor-pointer rounded accent-primary"
          />
          <div className="flex flex-col">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-headline-md text-headline-md font-bold text-on-surface">{`${doc.type} ${doc.number}`}</span>
              {KIND_PILL[doc.type] && (
                <span className="rounded-full bg-tertiary-fixed px-2 py-0.5 font-code-sm text-code-sm font-bold text-on-tertiary-fixed">
                  {KIND_PILL[doc.type]}
                </span>
              )}
              <StatusBadge status={doc.status} />
              {doc.hasObservations && (
                <span className="font-code-sm text-code-sm text-tertiary">Con observaciones</span>
              )}
            </div>
            <span className="mt-0.5 font-label-sm text-label-sm text-outline">
              {`Emitido ${formatIssuedAt(doc.issuedAt)}`}
            </span>
          </div>
        </div>
        <div className="flex flex-col items-end text-right">
          <Total doc={doc} />
        </div>
      </div>
      <div className="flex flex-col justify-between gap-2 pt-1 font-body-sm text-body-sm sm:flex-row sm:items-center">
        <div className="flex max-w-md items-center gap-2 truncate font-medium text-on-surface">
          <Icon aria-hidden="true" className="size-4 shrink-0 text-outline" />
          <span className="truncate">{doc.receiverName}</span>
          {doc.receiverRuc && (
            <span className="rounded bg-surface-container px-1.5 py-0.5 font-code-sm text-code-sm text-on-surface-variant">
              {`RUC: ${doc.receiverRuc}`}
            </span>
          )}
        </div>
        <CdcDisplay value={doc.cdc} variant="truncated" />
      </div>
      <div className="flex items-center justify-between pt-1">
        <button type="button" onClick={onOpen} className={ACTION}>
          Ver detalle
        </button>
        <button
          type="button"
          aria-label={`Más acciones para ${doc.number}`}
          className="rounded p-1 text-outline hover:text-on-surface"
        >
          <EllipsisVertical aria-hidden="true" className="size-[18px]" />
        </button>
      </div>
    </li>
  );
}
