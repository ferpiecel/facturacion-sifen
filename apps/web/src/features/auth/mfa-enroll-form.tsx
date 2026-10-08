'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type SubmitEvent } from 'react';

import type { AuthClient, ConfirmEnrollmentResult, EnrollResult } from './auth-client';
import { BUTTON_CLASS, FIELD_CLASS, FormError } from './auth-card';
import { authClient } from './default-client';
import { failureMessage } from './messages';

type Done = Extract<ConfirmEnrollmentResult, { kind: 'ok' }>;

const TOTP = /^\d{6}$/;

const groups = (secret: string) => secret.match(/.{1,4}/g)?.join(' ') ?? secret;

/** First-login enrolment: the QR is drawn in the browser and the otpauth URI never leaves it; recovery codes are shown once. */
export function MfaEnrollForm({ client = authClient }: { client?: AuthClient }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const started = useRef(false);
  const [enrollment, setEnrollment] = useState<EnrollResult | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    // Each call replaces the pending secret server-side: run once (StrictMode mounts twice in dev).
    if (started.current) return;
    started.current = true;
    void client.enrollMfa().then(async (result) => {
      if (result.kind === 'ok') {
        const { default: QRCode } = await import('qrcode');
        setQr(await QRCode.toDataURL(result.otpauthUri, { margin: 1, width: 224 }));
      }
      setEnrollment(result);
    });
  }, [client]);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const code = (input.current?.value ?? '').replace(/\s+/g, '');
    if (!TOTP.test(code)) {
      setError('Ingresá los 6 dígitos de tu app de autenticación.');
      input.current?.focus();
      return;
    }
    setError(null);
    setPending(true);
    const result = await client.confirmMfaEnrollment(code);
    setPending(false);
    if (result.kind === 'ok') {
      setDone(result);
      return;
    }
    setError(
      failureMessage(
        result,
        'Código incorrecto o sesión vencida. Probá de nuevo o volvé a ingresar.',
      ),
    );
    input.current?.focus();
  }

  function proceed(result: Done) {
    if (result.activeTenant) router.replace('/');
    else if (result.tenants.length > 0) router.replace('/seleccionar-empresa');
    else
      setError('Tu cuenta no tiene empresas asignadas. Pedile a un administrador que te agregue.');
  }

  if (done) {
    return (
      <div className="flex flex-col gap-space-md">
        <FormError message={error} />
        <p className="font-body-md text-body-md text-on-surface">
          Guardá estos códigos de recuperación en un lugar seguro. Cada uno sirve una sola vez si
          perdés tu app de autenticación. No volverás a verlos.
        </p>
        <ul className="grid grid-cols-1 gap-space-xs rounded-lg bg-surface-container p-space-md font-code-md text-code-md text-on-surface">
          {done.recoveryCodes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
        <label className="flex items-start gap-space-sm font-body-sm text-body-sm text-on-surface">
          <input
            type="checkbox"
            checked={saved}
            onChange={(event) => {
              setSaved(event.target.checked);
            }}
            className="mt-1"
          />
          Guardé mis códigos de recuperación
        </label>
        <button
          type="button"
          disabled={!saved}
          onClick={() => {
            proceed(done);
          }}
          className={BUTTON_CLASS}
        >
          Continuar
        </button>
      </div>
    );
  }

  if (enrollment && enrollment.kind !== 'ok') {
    return (
      <div className="flex flex-col gap-space-md">
        <FormError
          message={failureMessage(
            enrollment,
            'Tu sesión venció. Volvé a ingresar para activar la verificación.',
          )}
        />
        <Link
          href="/login"
          className="text-center font-body-sm text-body-sm text-primary underline-offset-2 hover:underline"
        >
          Volver a ingresar
        </Link>
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      noValidate
      className="flex flex-col gap-space-md"
    >
      <FormError message={error} />
      {qr ? (
        // eslint-disable-next-line @next/next/no-img-element -- a data: URL drawn in the browser; next/image cannot optimise it
        <img
          src={qr}
          alt="Código QR para tu app de autenticación"
          width={224}
          height={224}
          className="mx-auto rounded-lg bg-white"
        />
      ) : (
        <p className="text-center font-body-sm text-body-sm text-on-surface-variant">
          Preparando el código…
        </p>
      )}
      {enrollment?.kind === 'ok' && (
        <p className="text-center font-body-sm text-body-sm text-on-surface-variant">
          ¿No podés escanear? Ingresá esta clave a mano:{' '}
          <span className="font-code-md text-code-md text-on-surface">
            {groups(enrollment.secret)}
          </span>
        </p>
      )}
      <div className="flex flex-col gap-space-xs">
        <label htmlFor="code" className="font-label-md text-label-md text-on-surface-variant">
          Código de 6 dígitos
        </label>
        <input
          ref={input}
          id="code"
          name="code"
          type="text"
          autoComplete="one-time-code"
          inputMode="numeric"
          className={`${FIELD_CLASS} font-code-md text-code-md tracking-widest`}
        />
      </div>
      <button type="submit" disabled={pending || !enrollment} className={BUTTON_CLASS}>
        {pending ? 'Verificando…' : 'Activar'}
      </button>
    </form>
  );
}
