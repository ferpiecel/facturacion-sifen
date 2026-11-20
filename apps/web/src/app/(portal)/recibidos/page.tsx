import { PanelShell } from '../../../features/panel/panel-shell';

/** Placeholder: the read-only list (R7.6) and detail (R7.5) of received documents land here. */
export default function ReceivedDocumentsPage() {
  return (
    <PanelShell environment="test" activePath="/recibidos">
      <h1 className="text-xl font-semibold">Documentos recibidos</h1>
      <p className="mt-space-sm">Pronto podrás consultar aquí los documentos que recibes.</p>
    </PanelShell>
  );
}
