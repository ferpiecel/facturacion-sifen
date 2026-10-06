import type { Metadata } from 'next';

import { AuthCard } from '../../features/auth/auth-card';
import { LoginForm } from '../../features/auth/login-form';

export const metadata: Metadata = { title: 'Ingresar | SifenFlow' };

export default function LoginPage() {
  return (
    <AuthCard
      title="Ingresar al portal"
      description="Usá tu correo y tu contraseña. Después te pediremos el código de verificación."
    >
      <LoginForm />
    </AuthCard>
  );
}
