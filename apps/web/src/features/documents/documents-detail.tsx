'use client';

import { useCallback, useState, type KeyboardEvent } from 'react';

import { StatusBadge } from '../../design-system/components/status-badge';
import { documentsClient, type DetailResult, type DocumentsClient } from './documents-client';
import { DocumentsEvents } from './documents-events';
import { DocumentsKude } from './documents-kude';
import { DocumentsXml } from './documents-xml';
import { useRemote } from './use-remote';

const TABS = ['Vista Gráfica KuDE', 'XML Firmado <rDE>', 'Eventos & Trazabilidad'] as const;

const ENVIRONMENTS: Record<string, string> = { test: 'Pruebas', prod: 'Producción' };
const MESSAGE = 'p-6 text-center font-body-sm text-body-sm text-on-surface-variant';

/** Inspector of the Stitch explorer (right column): signature metadata and KuDE preview. */
export function DocumentsDetail({
  documentId,
  client = documentsClient,
}: {
  documentId: string | undefined;
  client?: DocumentsClient;
}) {
  const [tab, setTab] = useState(0);
  const load = useCallback(
    (): Promise<DetailResult | { kind: 'idle' }> =>
      documentId === undefined
        ? Promise.resolve({ kind: 'idle' as const })
        : client.detail(documentId),
    [client, documentId],
  );
  const { state, retry } = useRemote(load);
  const doc = state?.kind === 'ok' ? state.document : undefined;

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (step === undefined) return;
    const next = (tab + step + TABS.length) % TABS.length;
    setTab(next);
    document.getElementById(`detail-tab-${String(next)}`)?.focus();
  };

  return (
    <section
      aria-label="Detalle del comprobante"
      className="flex flex-col overflow-hidden rounded-xl bg-surface-container-lowest shadow-sm xl:sticky xl:top-28"
    >
      {doc ? (
        <>
          <div className="flex flex-col gap-2 bg-surface-container p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-headline-md text-headline-md font-bold text-on-surface">{`${doc.type} ${doc.number}`}</h2>
              <StatusBadge status={doc.status} />
            </div>
            <div className="font-code-sm text-code-sm text-on-surface-variant">
              {`Ambiente: ${ENVIRONMENTS[doc.environment] ?? doc.environment}`}
            </div>
          </div>
          <div
            role="tablist"
            aria-label="Vistas del comprobante"
            className="flex items-center bg-surface-container-low px-4 pt-2"
          >
            {TABS.map((label, index) => (
              <button
                key={label}
                id={`detail-tab-${String(index)}`}
                type="button"
                role="tab"
                aria-selected={tab === index}
                aria-controls="detail-panel"
                tabIndex={tab === index ? 0 : -1}
                onClick={() => {
                  setTab(index);
                }}
                onKeyDown={onKeyDown}
                className={`px-3 py-2 font-body-sm text-body-sm ${
                  tab === index
                    ? 'rounded-t-lg border-b-2 border-primary bg-surface-container-lowest font-semibold text-primary'
                    : 'font-medium text-on-surface-variant transition-colors hover:text-on-surface'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div role="tabpanel" id="detail-panel" aria-labelledby={`detail-tab-${String(tab)}`}>
            {tab === 0 && <DocumentsKude document={doc} client={client} />}
            {tab === 1 && <DocumentsXml id={doc.id} client={client} />}
            {tab === 2 && <DocumentsEvents document={doc} />}
          </div>
        </>
      ) : state === undefined && documentId !== undefined ? (
        <p role="status" className={MESSAGE}>
          Cargando comprobante…
        </p>
      ) : state?.kind === 'not_found' ? (
        <p role="alert" className={MESSAGE}>
          El comprobante no existe o no pertenece a la empresa activa.
        </p>
      ) : state?.kind === 'unavailable' ? (
        <div role="alert" className={`${MESSAGE} flex flex-col items-center gap-2`}>
          <span>No pudimos cargar el comprobante. Intentá de nuevo.</span>
          <button
            type="button"
            onClick={retry}
            className="rounded bg-surface-container px-3 py-1.5 font-label-md text-label-md font-semibold text-primary hover:bg-surface-container-high"
          >
            Reintentar
          </button>
        </div>
      ) : (
        <p className={MESSAGE}>Selecciona un comprobante para ver su detalle.</p>
      )}
    </section>
  );
}
