import { describe, expect, it } from 'vitest';
import { EmailConfigError, loadEmailConfig } from './email-config.js';

const SMTP = {
  SMTP_HOST: 'smtp.example.com',
  EMAIL_FROM_ADDRESS: 'facturas@example.com',
};

describe('loadEmailConfig', () => {
  it('is disabled outside production when nothing is configured', () => {
    expect(loadEmailConfig({ NODE_ENV: 'development' })).toEqual({ enabled: false });
    expect(loadEmailConfig({ NODE_ENV: 'test' })).toEqual({ enabled: false });
  });

  it('enables itself outside production when SMTP is configured', () => {
    expect(loadEmailConfig({ NODE_ENV: 'test', ...SMTP })).toEqual({
      enabled: true,
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      allowPlaintext: false,
      fromAddress: 'facturas@example.com',
    });
  });

  it('honours EMAIL_ENABLED=false even with SMTP configured, in any environment', () => {
    expect(loadEmailConfig({ NODE_ENV: 'production', EMAIL_ENABLED: 'false', ...SMTP })).toEqual({
      enabled: false,
    });
    expect(loadEmailConfig({ NODE_ENV: 'development', EMAIL_ENABLED: 'false', ...SMTP })).toEqual({
      enabled: false,
    });
  });

  it('fails closed in production when SMTP is missing and email is not disabled', () => {
    expect(() => loadEmailConfig({ NODE_ENV: 'production' })).toThrow(EmailConfigError);
    expect(() => loadEmailConfig({ NODE_ENV: 'production', EMAIL_ENABLED: 'true' })).toThrow(
      /SMTP_HOST is required/,
    );
    expect(() =>
      loadEmailConfig({ NODE_ENV: 'production', SMTP_HOST: 'smtp.example.com' }),
    ).toThrow(/EMAIL_FROM_ADDRESS is required/);
  });

  it('requires SMTP when EMAIL_ENABLED=true outside production', () => {
    expect(() => loadEmailConfig({ NODE_ENV: 'development', EMAIL_ENABLED: 'true' })).toThrow(
      /SMTP_HOST is required/,
    );
  });

  it('rejects an EMAIL_ENABLED that is neither true nor false', () => {
    expect(() => loadEmailConfig({ EMAIL_ENABLED: 'yes', ...SMTP })).toThrow(/EMAIL_ENABLED/);
  });

  it('parses port, TLS and credentials', () => {
    expect(
      loadEmailConfig({
        NODE_ENV: 'production',
        ...SMTP,
        SMTP_PORT: '465',
        SMTP_SECURE: 'true',
        SMTP_USER: 'mailer',
        SMTP_PASSWORD: 's3cret',
      }),
    ).toMatchObject({ port: 465, secure: true, user: 'mailer', password: 's3cret' });
  });

  it('rejects bad ports, flags and half-defined credentials without echoing values', () => {
    for (const env of [
      { SMTP_PORT: '0' },
      { SMTP_PORT: '70000' },
      { SMTP_PORT: 'abc' },
      { SMTP_SECURE: 'maybe' },
      { SMTP_USER: 'mailer' },
      { SMTP_PASSWORD: 'hunter2-hunter2' },
      { EMAIL_FROM_ADDRESS: 'not-an-address' },
      { EMAIL_FROM_ADDRESS: 'a@b.com\r\nBcc: x@y.com' },
    ]) {
      let message = '';
      try {
        loadEmailConfig({ NODE_ENV: 'test', ...SMTP, ...env });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, JSON.stringify(Object.keys(env))).not.toBe('');
      for (const value of Object.values(env)) expect(message).not.toContain(value);
    }
  });

  it('allows plaintext SMTP only in development and test', () => {
    expect(
      loadEmailConfig({ NODE_ENV: 'development', ...SMTP, SMTP_ALLOW_PLAINTEXT: 'true' }),
    ).toMatchObject({ allowPlaintext: true });
    expect(() =>
      loadEmailConfig({ NODE_ENV: 'production', ...SMTP, SMTP_ALLOW_PLAINTEXT: 'true' }),
    ).toThrow(/SMTP_ALLOW_PLAINTEXT/);
  });

  it('fails closed unless NODE_ENV is exactly development or test', () => {
    for (const NODE_ENV of [undefined, 'staging', 'prod', 'Production']) {
      expect(() => loadEmailConfig({ NODE_ENV })).toThrow(/SMTP_HOST is required/);
    }
    expect(loadEmailConfig({ NODE_ENV: undefined, EMAIL_ENABLED: 'false' })).toEqual({
      enabled: false,
    });
  });

  it('requires implicit TLS on port 465', () => {
    expect(() => loadEmailConfig({ NODE_ENV: 'test', ...SMTP, SMTP_PORT: '465' })).toThrow(
      /SMTP_SECURE/,
    );
    expect(
      loadEmailConfig({ NODE_ENV: 'test', ...SMTP, SMTP_PORT: '465', SMTP_SECURE: 'true' }),
    ).toMatchObject({ port: 465, secure: true });
  });
});
