'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, type SubmitEvent } from 'react';

import type { AuthClient } from './auth-client';
import { BUTTON_CLASS, FIELD_CLASS, FormError } from './auth-card';
import { authClient } from './default-client';
import { failureMessage } from './messages';

type Mode = 'totp' | 'recovery';

const TOTP = /^\d{6}$/;
// Same shape the API accepts for a recovery code (base32 groups, optional spaces or dashes).
const RECOVERY = /^[a-zA-Z2-7 -]{16,23}$/;

export function MfaForm({ client = authClient }: { client?: AuthClient }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<Mode>('totp');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const raw = input.current?.value ?? '';
    const code = mode === 'totp' ? raw.replace(/\s+/g, '') : raw.trim();
    if (!(mode === 'totp' ? TOTP : RECOVERY).test(code)) {
      setError(
        mode === 'totp'
          ? 'Ingresá los 6 dígitos de tu app de autenticación.'
          : 'Revisá el código de recuperación: tiene 16 letras y números.',
      );
      input.current?.focus();
      return;
    }
    setError(null);
    setPending(true);
    const result = await client.verifyMfa(code);
    if (result.kind === 'ok') {
      if (result.activeTenant) router.replace('/');
      else if (result.tenants.length > 0) router.replace('/seleccionar-empresa');
      else {
        setPending(false);
        setError(
          'Tu cuenta no tiene empresas asignadas. Pedile a un administrador que te agregue.',
        );
      }
      return;
    }
    setPending(false);
    setError(
      failureMessage(
        result,
        'Código incorrecto o sesión vencida. Probá de nuevo o volvé a ingresar.',
      ),
    );
    input.current?.focus();
  }

  const totp = mode === 'totp';
  return (
    <form
      onSubmit={(event) => void submit(event)}
      noValidate
      className="flex flex-col gap-space-md"
    >
      <FormError message={error} />
      <div className="flex flex-col gap-space-xs">
        <label htmlFor="code" className="font-label-md text-label-md text-on-surface-variant">
          {totp ? 'Código de 6 dígitos' : 'Código de recuperación'}
        </label>
        <input
          key={mode}
          ref={input}
          id="code"
          name="code"
          type="text"
          autoFocus
          autoComplete={totp ? 'one-time-code' : 'off'}
          inputMode={totp ? 'numeric' : 'text'}
          aria-invalid={error ? true : undefined}
          className={`${FIELD_CLASS} font-code-md text-code-md tracking-widest`}
        />
      </div>
      <button type="submit" disabled={pending} className={BUTTON_CLASS}>
        {pending ? 'Verificando…' : 'Verificar'}
      </button>
      <button
        type="button"
        onClick={() => {
          setError(null);
          setMode(totp ? 'recovery' : 'totp');
        }}
        className="font-body-sm text-body-sm text-primary underline-offset-2 hover:underline"
      >
        {totp ? 'Usar un código de recuperación' : 'Usar el código de la app'}
      </button>
      <Link
        href="/login"
        className="text-center font-body-sm text-body-sm text-on-surface-variant underline-offset-2 hover:underline"
      >
        Volver a ingresar
      </Link>
    </form>
  );
}
