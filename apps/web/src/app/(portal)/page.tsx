import { PanelDashboard } from '../../features/panel/panel-dashboard';
import { PanelShell } from '../../features/panel/panel-shell';

export default function HomePage() {
  return (
    <PanelShell environment="test" activePath="/">
      <PanelDashboard />
    </PanelShell>
  );
}
