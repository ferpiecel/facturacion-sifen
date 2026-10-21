import { AttentionScreen } from '../../../features/attention/attention-screen';
import { PanelShell } from '../../../features/panel/panel-shell';

export default function ActionRequiredPage() {
  return (
    <PanelShell environment="test" activePath="/accion-requerida">
      <AttentionScreen />
    </PanelShell>
  );
}
