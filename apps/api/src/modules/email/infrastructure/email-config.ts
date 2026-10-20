/** Invalid email settings. Messages name the variable, never its value (credentials, addresses). */
export class EmailConfigError extends Error {
  override name = 'EmailConfigError';
}

export type EmailConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly host: string;
      readonly port: number;
      /** `true`: implicit TLS (port 465). `false`: STARTTLS, required unless `allowPlaintext`. */
      readonly secure: boolean;
      readonly allowPlaintext: boolean;
      readonly user?: string;
      readonly password?: string;
      /** The platform's sender address (MVP: one SMTP account for every tenant). */
      readonly fromAddress: string;
    };

type Env = Readonly<Record<string, string | undefined>>;

const ADDRESS = /^[^\s@<>",;:\\]+@[^\s@<>",;:\\]+\.[^\s@<>",;:\\]+$/;

function flag(env: Env, name: string): boolean | undefined {
  const raw = env[name];
  if (raw === undefined || raw === '') return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new EmailConfigError(`${name} must be "true" or "false"`);
}

/**
 * Reads the email settings (docs/configuracion.md). Fails closed: in production the SMTP account is
 * mandatory unless `EMAIL_ENABLED=false` switches the channel off explicitly. Elsewhere email is on
 * only when `SMTP_HOST` is set or `EMAIL_ENABLED=true`.
 */
export function loadEmailConfig(env: Env): EmailConfig {
  const requested = flag(env, 'EMAIL_ENABLED');
  if (requested === false) return { enabled: false };
  const production = env.NODE_ENV === 'production';
  const host = env.SMTP_HOST ?? '';
  if (!production && requested !== true && host === '') return { enabled: false };

  if (host === '') throw new EmailConfigError('SMTP_HOST is required');
  const fromAddress = env.EMAIL_FROM_ADDRESS ?? '';
  if (fromAddress === '') throw new EmailConfigError('EMAIL_FROM_ADDRESS is required');
  if (!ADDRESS.test(fromAddress)) {
    throw new EmailConfigError('EMAIL_FROM_ADDRESS must be a plain email address');
  }

  const rawPort = env.SMTP_PORT;
  const port = rawPort === undefined || rawPort === '' ? 587 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new EmailConfigError('SMTP_PORT must be an integer between 1 and 65535');
  }

  const allowPlaintext = flag(env, 'SMTP_ALLOW_PLAINTEXT') ?? false;
  if (allowPlaintext && !(env.NODE_ENV === 'development' || env.NODE_ENV === 'test')) {
    throw new EmailConfigError('SMTP_ALLOW_PLAINTEXT is only allowed with development or test');
  }

  const user = env.SMTP_USER ?? '';
  const password = env.SMTP_PASSWORD ?? '';
  if ((user === '') !== (password === '')) {
    throw new EmailConfigError('SMTP_USER and SMTP_PASSWORD must be set together');
  }

  return {
    enabled: true,
    host,
    port,
    secure: flag(env, 'SMTP_SECURE') ?? false,
    allowPlaintext,
    ...(user === '' ? {} : { user, password }),
    fromAddress,
  };
}
