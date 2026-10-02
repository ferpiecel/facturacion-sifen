'use client';

import { BadgeCheck } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';

import { DocumentsEvents } from './documents-events';
import { DocumentsKude } from './documents-kude';
import { DocumentsXml } from './documents-xml';
import type { DocumentRow } from './sample-documents';

const TABS = ['Vista Gráfica KuDE', 'XML Firmado <rDE>', 'Eventos & Trazabilidad'] as const;

const ACTION =
  'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-label-md text-label-md font-semibold shadow-sm';

/** Inspector of the Stitch explorer (right column): signature metadata and KuDE preview. */
export function DocumentsDetail({ doc }: { doc: DocumentRow | undefined }) {
  const [tab, setTab] = useState(0);

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
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span aria-hidden="true" className="size-2.5 rounded-full bg-secondary" />
                <h2 className="font-headline-md text-headline-md font-bold text-on-surface">{`${doc.kind} ${doc.number}`}</h2>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="rounded bg-surface-container-lowest px-2 py-0.5 font-code-sm text-code-sm font-bold text-primary shadow-sm">
                  SIFEN v150 OK
                </span>
                <BadgeCheck
                  aria-label="Firma digital válida"
                  className="size-[18px] text-secondary"
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between pt-1 font-code-sm text-code-sm text-on-surface-variant">
              <span>Certificado: ACME PARAGUAY S.A.</span>
              <span className="font-semibold text-secondary">XMLDSig RSA-SHA256</span>
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
            {tab === 1 && <DocumentsXml doc={doc} />}
            {tab === 2 && <DocumentsEvents doc={doc} />}
            {tab === 0 && (
              <div className="flex flex-col gap-4 p-4">
                <div className="flex items-center justify-between rounded-lg bg-surface-container-low p-2.5">
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      className={`${ACTION} bg-surface-container-lowest text-on-surface`}
                    >
                      Imprimir PDF
                    </button>
                    <button
                      type="button"
                      className={`${ACTION} bg-surface-container-lowest text-on-surface`}
                    >
                      A4 / Ticket POS
                    </button>
                  </div>
                  <button type="button" className={`${ACTION} bg-secondary text-on-secondary`}>
                    Enviar por email
                  </button>
                </div>
                <DocumentsKude doc={doc} />
              </div>
            )}
          </div>
        </>
      ) : (
        <p className="p-6 text-center font-body-sm text-body-sm text-on-surface-variant">
          Selecciona un comprobante aprobado para ver su KuDE.
        </p>
      )}
    </section>
  );
}
