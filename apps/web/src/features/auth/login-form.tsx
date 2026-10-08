'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, type SubmitEvent } from 'react';

import type { AuthClient } from './auth-client';
import { BUTTON_CLASS, FIELD_CLASS, FormError } from './auth-card';
import { authClient } from './default-client';
import { failureMessage } from './messages';

export function LoginForm({ client = authClient }: { client?: AuthClient }) {
  const router = useRouter();
  const email = useRef<HTMLInputElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const emailValue = email.current?.value.trim() ?? '';
    const passwordValue = password.current?.value ?? '';
    if (emailValue === '' || passwordValue === '') {
      setError('Ingresá tu correo y tu contraseña.');
      return;
    }
    setError(null);
    setPending(true);
    const result = await client.login(emailValue, passwordValue);
    if (result.kind === 'mfa_required') {
      router.push('/login/mfa');
      return;
    }
    if (result.kind === 'mfa_enrollment_required') {
      router.push('/login/mfa/enrolar');
      return;
    }
    setPending(false);
    setError(failureMessage(result, 'Correo o contraseña incorrectos.'));
    email.current?.focus();
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      noValidate
      className="flex flex-col gap-space-md"
    >
      <FormError message={error} />
      <div className="flex flex-col gap-space-xs">
        <label htmlFor="email" className="font-label-md text-label-md text-on-surface-variant">
          Correo electrónico
        </label>
        <input
          ref={email}
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          aria-invalid={error ? true : undefined}
          className={FIELD_CLASS}
        />
      </div>
      <div className="flex flex-col gap-space-xs">
        <label htmlFor="password" className="font-label-md text-label-md text-on-surface-variant">
          Contraseña
        </label>
        <input
          ref={password}
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          aria-invalid={error ? true : undefined}
          className={FIELD_CLASS}
        />
      </div>
      <button type="submit" disabled={pending} className={BUTTON_CLASS}>
        {pending ? 'Ingresando…' : 'Ingresar'}
      </button>
    </form>
  );
}
