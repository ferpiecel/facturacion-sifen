import type { Metadata } from 'next';

import { AuthCard } from '../../features/auth/auth-card';
import { TenantPicker } from '../../features/auth/tenant-picker';

export const metadata: Metadata = { title: 'Elegir empresa | SifenFlow' };

export default function TenantPage() {
  return (
    <AuthCard
      title="Elegí una empresa"
      description="Tu usuario pertenece a más de una empresa. Podés cambiar de empresa más adelante."
    >
      <TenantPicker />
    </AuthCard>
  );
}
