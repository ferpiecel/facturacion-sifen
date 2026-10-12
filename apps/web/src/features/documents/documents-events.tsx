import { Ban } from 'lucide-react';

import { StatusBadge } from '../../design-system/components/status-badge';
import type { DocumentDetail } from './documents-client';
import { formatIssuedAt } from './format';

const HOURS_TO_CANCEL = { FE: 48, NCE: 168, NDE: 168, AFE: 168 } as const;

/** Events tab: timeline plus the cancellation action with its SIFEN window (HU-E8-02). */
export function DocumentsEvents({ document }: { document: DocumentDetail }) {
  // No cancellation window is known for a SIFEN type the portal has no code for.
  const hours = document.type ? HOURS_TO_CANCEL[document.type] : undefined;
  const deadline = hours === undefined ? '' : formatIssuedAt(document.issuedAt, hours * 3600);

  return (
    <div className="flex flex-col gap-4 p-4">
      {document.rejectionReason && (
        <p
          role="alert"
          className="rounded-lg bg-error-container p-3 font-body-sm text-body-sm text-on-error-container"
        >
          <strong className="block font-label-md text-label-md">Motivo del rechazo</strong>
          {document.rejectionReason}
        </p>
      )}
      <span className="font-label-md text-label-md font-medium text-on-surface-variant">
        Ciclo de Vida del Documento Electrónico
      </span>
      <ol aria-label="Ciclo de vida del comprobante" className="relative flex flex-col gap-4 pl-6">
        {document.events.map(({ status, at, code, message }) => (
          <li key={`${status}-${at}`} className="relative flex flex-col">
            <span
              aria-hidden="true"
              className="absolute top-1 -left-6 size-3 rounded-full bg-secondary"
            />
            <div className="flex items-center justify-between font-label-md text-label-md font-semibold text-on-surface">
              <StatusBadge status={status} />
              <span className="font-code-sm text-code-sm text-outline">{formatIssuedAt(at)}</span>
            </div>
            {(code ?? message) && (
              <p className="mt-0.5 font-body-sm text-body-sm text-on-surface-variant">
                {[code, message].filter(Boolean).join(': ')}
              </p>
            )}
          </li>
        ))}
      </ol>
      {hours !== undefined && (
        <div className="mt-2 flex flex-col gap-2 rounded-lg bg-surface-container-low p-3">
          <span className="font-label-sm text-label-sm font-bold text-on-surface uppercase">
            Gestión de Eventos SIFEN
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="flex items-center gap-1 rounded bg-error-container px-3 py-1.5 font-label-sm text-label-sm font-semibold text-on-error-container hover:opacity-90"
            >
              <Ban aria-hidden="true" className="size-4" />
              Cancelar en SIFEN
            </button>
            <span className="font-label-sm text-label-sm text-on-surface-variant">
              {`Plazo de cancelación: hasta ${deadline} (${String(hours)} h desde la aprobación)`}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
