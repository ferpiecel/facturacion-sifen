import { Download, ExternalLink } from 'lucide-react';

import type { ReceivedDocumentDetail } from './reception-client';

type Artifact = ReceivedDocumentDetail['artifact'];

/** Types the portal route serves `inline` (`INLINE_TYPES` of the API controller) and that are safe in an `<img>`. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const LINK =
  'inline-flex items-center gap-1 rounded bg-surface-container px-3 py-1.5 font-label-md text-label-md font-semibold text-primary hover:bg-surface-container-high';

/**
 * Read-only viewer of the stored artifact. `href` MUST be `receptionClient.artifactUrl(id)` (never the detail's
 * `artifact_url`, which is the API path). Presentation by content type:
 * - png/jpeg/webp: `<img>` (page CSP `img-src 'self'`).
 * - PDF: open-in-new-tab link plus download, NOT an embed. The page CSP has `object-src 'none'` and
 *   `frame-ancestors 'none'` plus `X-Frame-Options: DENY`, which also apply to the proxied artifact response, so
 *   framing it would need loosening them; a top-level navigation needs no CSP change.
 * - XML and anything else (the server serves these as `attachment`): a download link only, never an embed.
 */
export function ArtifactViewer({ artifact, href }: { artifact: Artifact; href: string }) {
  if (!artifact) {
    return (
      <p className="font-body-sm text-body-sm text-on-surface-variant">
        Este documento no tiene un archivo adjunto.
      </p>
    );
  }
  const name = artifact.original_name ?? 'Artefacto del documento';
  const type = artifact.content_type.toLowerCase();
  return (
    <div className="flex flex-col gap-3">
      {IMAGE_TYPES.has(type) && (
        // eslint-disable-next-line @next/next/no-img-element -- same-origin streamed artifact, not an optimizable asset
        <img src={href} alt={name} className="max-h-[32rem] max-w-full rounded border" />
      )}
      <div className="flex flex-wrap items-center gap-2">
        {type === 'application/pdf' && (
          <a href={href} target="_blank" rel="noopener noreferrer" className={LINK}>
            <ExternalLink aria-hidden="true" className="size-4" />
            Abrir artefacto
          </a>
        )}
        <a href={href} download={artifact.original_name ?? ''} className={LINK}>
          <Download aria-hidden="true" className="size-4" />
          Descargar
        </a>
        <span className="font-label-sm text-label-sm text-on-surface-variant">
          {`${name} · ${type} · ${String(artifact.size_bytes)} bytes`}
        </span>
      </div>
    </div>
  );
}
