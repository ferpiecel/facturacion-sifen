import { DocumentsHeader } from './documents-header';
import { DocumentsKpis } from './documents-kpis';

/** Content of the Stitch "Comprobantes y KuDE" screen. */
export function DocumentsExplorer() {
  return (
    <div className="mx-auto flex w-full max-w-[1560px] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <DocumentsHeader />
      <DocumentsKpis />
    </div>
  );
}
