import type { Metadata } from 'next';

import { AuthCard } from '../../../features/auth/auth-card';
import { MfaForm } from '../../../features/auth/mfa-form';

export const metadata: Metadata = { title: 'Verificación | SifenFlow' };

export default function MfaPage() {
  return (
    <AuthCard
      title="Verificación en dos pasos"
      description="Ingresá el código de tu app de autenticación o un código de recuperación."
    >
      <MfaForm />
    </AuthCard>
  );
}
