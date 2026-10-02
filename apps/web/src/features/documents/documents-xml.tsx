import { Copy, FileCheck } from 'lucide-react';

import { buildSampleXml } from './sample-xml';
import type { DocumentRow } from './sample-documents';

const ACTION =
  'flex items-center gap-1 rounded bg-surface-container px-2.5 py-1 font-label-sm text-label-sm font-semibold hover:bg-surface-container-high';

/** XML tab: abridged signed rDE preview with its actions. */
export function DocumentsXml({ doc }: { doc: DocumentRow }) {
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <span className="font-label-md text-label-md font-medium text-on-surface-variant">
          Payload XML oficial (&lt;rDE&gt;) · XMLDSig RSA-SHA256
        </span>
        <div className="flex items-center gap-2">
          <button type="button" className={`${ACTION} text-primary`}>
            <Copy aria-hidden="true" className="size-3.5" />
            Copiar XML
          </button>
          <button type="button" className={`${ACTION} text-secondary`}>
            <FileCheck aria-hidden="true" className="size-3.5" />
            Validar XSD
          </button>
        </div>
      </div>
      <pre
        tabIndex={0}
        aria-label="XML firmado"
        className="max-h-96 overflow-auto rounded-xl bg-inverse-surface p-4 font-code-sm text-code-sm leading-relaxed text-inverse-on-surface"
      >
        <code>{buildSampleXml(doc)}</code>
      </pre>
    </div>
  );
}
