import Link from 'next/link';

import { PanelShell } from '../../../../features/panel/panel-shell';
import { ReceivedDetail } from '../../../../features/reception/received-detail';

/** Read-only detail of one received document (R7.5). */
export default async function ReceivedDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <PanelShell environment="test" activePath="/recibidos">
      <h1 className="text-xl font-semibold">Documento recibido</h1>
      <Link
        href="/recibidos"
        className="mt-space-xs inline-block text-sm font-semibold text-primary hover:underline"
      >
        Volver a documentos recibidos
      </Link>
      <div className="mt-space-sm">
        <ReceivedDetail id={id} />
      </div>
    </PanelShell>
  );
}
