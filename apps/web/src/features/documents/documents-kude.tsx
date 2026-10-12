'use client';

import { Download } from 'lucide-react';
import { useCallback, useEffect } from 'react';

import type { DocumentDetail, DocumentsClient } from './documents-client';
import { useRemote } from './use-remote';

const NOTE = 'p-6 text-center font-body-sm text-body-sm text-on-surface-variant';

/**
 * KuDE tab: the PDF is fetched once through the proxy and offered as a download. It is not embedded: the CSP
 * (`default-src 'self'`, `object-src 'none'`) does not allow framing a blob (debt: inline preview).
 */
export function DocumentsKude({
  document,
  client,
}: {
  document: DocumentDetail;
  client: DocumentsClient;
}) {
  const load = useCallback(
    () =>
      client
        .kude(document.id)
        .then((result) =>
          result.kind === 'ok' ? { ...result, href: URL.createObjectURL(result.pdf) } : result,
        ),
    [client, document.id],
  );
  const { state, retry } = useRemote(load);
  const href = state?.kind === 'ok' ? state.href : undefined;

  useEffect(
    () => () => {
      if (href) URL.revokeObjectURL(href);
    },
    [href],
  );

  if (!state)
    return (
      <p role="status" className={NOTE}>
        Cargando KuDE…
      </p>
    );
  if (state.kind === 'not_available') return <p className={NOTE}>KuDE no disponible todavía</p>;
  if (state.kind === 'not_found')
    return <p className={NOTE}>El KuDE de este comprobante no existe.</p>;
  if (state.kind !== 'ok')
    return (
      <div className={`${NOTE} flex flex-col items-center gap-2`}>
        <span>No pudimos cargar el KuDE.</span>
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
    <div className="flex justify-center p-6">
      <a
        href={href}
        download={`kude-${document.number}.pdf`}
        className="flex items-center gap-1.5 rounded-md bg-secondary px-3 py-2 font-label-md text-label-md font-semibold text-on-secondary shadow-sm"
      >
        <Download aria-hidden="true" className="size-4" />
        Descargar KuDE (PDF)
      </a>
    </div>
  );
}
