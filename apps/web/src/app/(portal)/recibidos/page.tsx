import { ReceivedList } from '../../../features/reception/received-list';
import { PanelShell } from '../../../features/panel/panel-shell';

/** Read-only list of received documents (R7.6); the detail (R7.5) lands later. */
export default function ReceivedDocumentsPage() {
  return (
    <PanelShell environment="test" activePath="/recibidos">
      <h1 className="text-xl font-semibold">Documentos recibidos</h1>
      <div className="mt-space-sm">
        <ReceivedList />
      </div>
    </PanelShell>
  );
}
