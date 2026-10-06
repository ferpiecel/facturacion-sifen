import type { ReactNode } from 'react';

import { SessionGate } from '../../features/auth/session-gate';

/** Every portal page behind the login: the session gate decides what the visitor may see. */
export default function PortalLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <SessionGate>{children}</SessionGate>;
}
