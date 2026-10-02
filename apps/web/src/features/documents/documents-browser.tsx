import { DocumentsRow } from './documents-row';
import { SAMPLE_DOCUMENTS_PAGE as PAGE } from './sample-documents';

/** Master list of the Stitch explorer (left column). */
export function DocumentsBrowser() {
  return (
    <div className="overflow-hidden rounded-xl bg-surface-container-lowest shadow-sm">
      <ul aria-label="Comprobantes" className="divide-y divide-surface-container-low">
        {PAGE.items.map((doc) => (
          <DocumentsRow key={doc.documentId} doc={doc} />
        ))}
      </ul>
    </div>
  );
}
