import type { Metadata } from 'next';

import { AuthCard } from '../../../../features/auth/auth-card';
import { MfaEnrollForm } from '../../../../features/auth/mfa-enroll-form';

export const metadata: Metadata = { title: 'Activar verificación | SifenFlow' };

export default function MfaEnrollPage() {
  return (
    <AuthCard
      title="Activá la verificación en dos pasos"
      description="Es obligatoria para todas las cuentas. Escaneá el código con tu app de autenticación y confirmá con el primer código."
    >
      <MfaEnrollForm />
    </AuthCard>
  );
}
