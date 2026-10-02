import { DocumentsExplorer } from '../../features/documents/documents-explorer';
import { PanelShell } from '../../features/panel/panel-shell';

export default function ComprobantesPage() {
  return (
    <PanelShell environment="test" activePath="/comprobantes">
      <DocumentsExplorer />
    </PanelShell>
  );
}
