import { Ban } from 'lucide-react';

import { formatClock, formatIssuedAt } from './format';
import type { DocumentRow } from './sample-documents';

const HOURS_TO_CANCEL = { FE: 48, NCE: 168, NDE: 168, AFE: 168 } as const;

/** Lifecycle derived from the document; the API will return the real events. */
function lifecycle(doc: DocumentRow) {
  const events = [
    {
      title: 'Comprobante generado y firmado',
      at: 1,
      detail: 'Firma XMLDSig RSA-SHA256 generada con el certificado del emisor.',
      dot: 'bg-secondary',
    },
    {
      title: 'Aprobado por SIFEN',
      at: 3,
      detail: `Código 0260: autorización del DE satisfactoria.${
        doc.latencyMs === undefined ? '' : ` Latencia de conexión: ${String(doc.latencyMs)} ms.`
      }`,
      dot: 'bg-secondary',
    },
  ];
  if (doc.detail?.notifiedTo) {
    events.push({
      title: 'KuDE notificado al cliente',
      at: 10,
      detail: `KuDE y XML enviados por email a ${doc.detail.notifiedTo}.`,
      dot: 'bg-primary',
    });
  }
  return events;
}

/** Events tab: timeline plus the cancellation action with its SIFEN window (HU-E8-02). */
export function DocumentsEvents({ doc }: { doc: DocumentRow }) {
  const hours = HOURS_TO_CANCEL[doc.kind];
  const deadline = formatIssuedAt(doc.issuedAt, hours * 3600);

  return (
    <div className="flex flex-col gap-4 p-4">
      <span className="font-label-md text-label-md font-medium text-on-surface-variant">
        Ciclo de Vida del Documento Electrónico
      </span>
      <ol aria-label="Ciclo de vida del comprobante" className="relative flex flex-col gap-4 pl-6">
        {lifecycle(doc).map(({ title, at, detail, dot }) => (
          <li key={title} className="relative flex flex-col">
            <span
              aria-hidden="true"
              className={`absolute top-1 -left-6 size-3 rounded-full ${dot}`}
            />
            <div className="flex items-center justify-between font-label-md text-label-md font-semibold text-on-surface">
              <span>{title}</span>
              <span className="font-code-sm text-code-sm text-outline">
                {formatClock(doc.issuedAt, at)}
              </span>
            </div>
            <p className="mt-0.5 font-body-sm text-body-sm text-on-surface-variant">{detail}</p>
          </li>
        ))}
      </ol>
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
    </div>
  );
}
