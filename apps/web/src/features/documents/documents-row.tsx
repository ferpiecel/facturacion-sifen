import { Building2, EllipsisVertical, User } from 'lucide-react';

import { CdcDisplay } from '../../design-system/components/cdc-display';
import { MoneyPYG } from '../../design-system/components/money-pyg';
import { formatPYG } from '../../design-system/lib/format-pyg';
import { StatusBadge } from '../../design-system/components/status-badge';
import { formatIssuedAt, iva10 } from './format';
import { ESTABLISHMENTS, type DocumentKind, type DocumentRow } from './sample-documents';

const KIND_PILL: Partial<Record<DocumentKind, string>> = {
  NCE: 'Nota de Crédito',
  NDE: 'Nota de Débito',
  AFE: 'Autofactura',
};

const ACTION =
  'flex items-center gap-1 rounded-md bg-surface-container px-2.5 py-1 font-label-sm text-label-sm font-semibold text-on-surface transition-colors hover:bg-surface-container-high';

function subtitle(doc: DocumentRow): string {
  const issued = formatIssuedAt(doc.issuedAt);
  if (doc.associatedNumber) return `Asociado a FE ${doc.associatedNumber} • ${issued}`;
  if (doc.status === 'en_lote') return `Emitido ${issued} • ${ESTABLISHMENTS[doc.establishment]}`;
  return `Emitido ${issued} • Timbrado N° ${doc.timbrado}`;
}

function Actions({ doc }: { doc: DocumentRow }) {
  if (doc.status === 'rechazado') {
    return (
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="rounded bg-surface-container-lowest px-2 py-1 font-label-sm text-label-sm font-semibold text-primary hover:bg-surface-container"
        >
          Corregir y re-emitir
        </button>
        <button
          type="button"
          className="rounded bg-surface-container-lowest px-2 py-1 font-label-sm text-label-sm font-medium text-on-surface hover:bg-surface-container"
        >
          Ver respuesta SIFEN
        </button>
      </div>
    );
  }
  if (doc.status === 'en_lote') {
    return (
      <span className="font-label-sm text-label-sm font-medium text-tertiary">
        Firmado localmente ✓
      </span>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <button type="button" className={ACTION}>
        Ver KuDE
      </button>
      <button type="button" className={ACTION}>
        XML
      </button>
    </div>
  );
}

/** One document of the Stitch master list. */
interface DocumentsRowProps {
  doc: DocumentRow;
  selected: boolean;
  onToggle: () => void;
}

export function DocumentsRow({ doc, selected, onToggle }: DocumentsRowProps) {
  const rejected = doc.rejection !== undefined;
  const Icon = doc.receiver.kind === 'ruc' ? Building2 : User;
  const signed = doc.kind === 'NCE' ? -doc.total : doc.total;

  return (
    <li
      aria-label={`${doc.kind} ${doc.number}`}
      className={`flex flex-col gap-2.5 p-4 transition-colors ${
        rejected
          ? 'bg-error-container/20 hover:bg-error-container/30'
          : selected
            ? 'bg-primary/5 hover:bg-primary/10'
            : 'hover:bg-surface-container-low'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            aria-label={`Seleccionar ${doc.kind} ${doc.number}`}
            checked={selected}
            onChange={onToggle}
            className="size-4 cursor-pointer rounded accent-primary"
          />
          <div className="flex flex-col">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-headline-md text-headline-md font-bold text-on-surface">{`${doc.kind} ${doc.number}`}</span>
              {KIND_PILL[doc.kind] && (
                <span className="rounded-full bg-tertiary-fixed px-2 py-0.5 font-code-sm text-code-sm font-bold text-on-tertiary-fixed">
                  {KIND_PILL[doc.kind]}
                </span>
              )}
              <StatusBadge status={doc.status} />
              {doc.batch && (
                <span className="font-code-sm text-code-sm text-tertiary">{`Lote #${doc.batch}`}</span>
              )}
            </div>
            {doc.rejection ? (
              <span className="mt-0.5 font-label-sm text-label-sm font-medium text-error">
                {`Error ${doc.rejection.code}: ${doc.rejection.message}`}
              </span>
            ) : (
              <span className="mt-0.5 font-label-sm text-label-sm text-outline">
                {subtitle(doc)}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end text-right">
          <MoneyPYG
            amount={signed}
            className="font-headline-md text-headline-md font-bold text-on-surface"
          />
          <span
            className={`font-label-sm text-label-sm ${rejected ? 'text-error' : 'text-on-surface-variant'}`}
          >
            {doc.note ?? `IVA 10%: ${formatPYG(iva10(doc.total))}`}
          </span>
        </div>
      </div>
      <div className="flex flex-col justify-between gap-2 pt-1 font-body-sm text-body-sm sm:flex-row sm:items-center">
        <div className="flex max-w-md items-center gap-2 truncate font-medium text-on-surface">
          <Icon aria-hidden="true" className="size-4 shrink-0 text-outline" />
          <span className="truncate">{doc.receiver.name}</span>
          {doc.receiver.id && (
            <span className="rounded bg-surface-container px-1.5 py-0.5 font-code-sm text-code-sm text-on-surface-variant">
              {`${doc.receiver.kind === 'ruc' ? 'RUC' : 'CI'}: ${doc.receiver.id}`}
            </span>
          )}
        </div>
        <CdcDisplay value={doc.cdc} variant="truncated" />
      </div>
      <div className="flex items-center justify-between pt-1">
        <Actions doc={doc} />
        <div className="flex items-center gap-1 text-outline">
          {doc.latencyMs !== undefined && (
            <span className="font-code-sm text-code-sm text-secondary">{`${String(doc.latencyMs)}ms SIFEN`}</span>
          )}
          <button
            type="button"
            aria-label={`Más acciones para ${doc.number}`}
            className="rounded p-1 hover:text-on-surface"
          >
            <EllipsisVertical aria-hidden="true" className="size-[18px]" />
          </button>
        </div>
      </div>
    </li>
  );
}
