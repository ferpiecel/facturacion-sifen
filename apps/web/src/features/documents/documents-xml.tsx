'use client';

import { Copy, Download } from 'lucide-react';
import { useCallback } from 'react';

import type { DocumentsClient } from './documents-client';
import { useRemote } from './use-remote';

const ACTION =
  'flex items-center gap-1 rounded bg-surface-container px-2.5 py-1 font-label-sm text-label-sm font-semibold text-primary hover:bg-surface-container-high';
const NOTE = 'p-6 text-center font-body-sm text-body-sm text-on-surface-variant';

/** XML tab: the signed rDE as the API stores it, with copy and download actions. */
export function DocumentsXml({ id, client }: { id: string; client: DocumentsClient }) {
  const load = useCallback(() => client.xml(id), [client, id]);
  const { state, retry } = useRemote(load);

  if (!state)
    return (
      <p role="status" className={NOTE}>
        Cargando XML…
      </p>
    );
  if (state.kind === 'not_found') return <p className={NOTE}>El XML todavía no está disponible.</p>;
  if (state.kind !== 'ok')
    return (
      <div className={`${NOTE} flex flex-col items-center gap-2`}>
        <span>No pudimos cargar el XML.</span>
        <button
          type="button"
          onClick={retry}
          className="font-semibold text-primary hover:underline"
        >
          Reintentar
        </button>
      </div>
    );
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <span className="font-label-md text-label-md font-medium text-on-surface-variant">
          Payload XML oficial (&lt;rDE&gt;)
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={ACTION}
            onClick={() => {
              void navigator.clipboard.writeText(state.xml);
            }}
          >
            <Copy aria-hidden="true" className="size-3.5" />
            Copiar XML
          </button>
          <a href={client.xmlUrl(id)} download className={ACTION}>
            <Download aria-hidden="true" className="size-3.5" />
            Descargar XML
          </a>
        </div>
      </div>
      <pre
        tabIndex={0}
        aria-label="XML firmado"
        className="max-h-96 overflow-auto rounded-xl bg-inverse-surface p-4 font-code-sm text-code-sm leading-relaxed text-inverse-on-surface"
      >
        <code>{state.xml}</code>
      </pre>
    </div>
  );
}
