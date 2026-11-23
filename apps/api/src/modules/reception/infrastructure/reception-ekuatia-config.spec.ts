import { describe, expect, it } from 'vitest';
import { loadReceptionEkuatiaConfig } from './reception-ekuatia-config.js';

describe('loadReceptionEkuatiaConfig', () => {
  it('is off by default, with conservative documented caps', () => {
    expect(loadReceptionEkuatiaConfig({})).toEqual({
      enabled: false,
      available: false,
      solverApiKey: null,
      tenantDailySolveCap: 20,
      globalDailySolveCap: 100,
      breakerFailureThreshold: 5,
      breakerCooldownMs: 900_000,
      baseUrl: 'https://ekuatia.set.gov.py',
      sitekey: '6Ldcb-wrAAAAAGp5mRQLnbGW0GFsKyi71OhYDImu',
    });
  });

  it.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['false', false],
    ['0', false],
    ['', false],
  ])('reads RECEPTION_EKUATIA_ENABLED=%j as %s', (value, expected) => {
    expect(loadReceptionEkuatiaConfig({ RECEPTION_EKUATIA_ENABLED: value }).enabled).toBe(expected);
  });

  it('rejects an unrecognised switch value instead of guessing', () => {
    expect(() => loadReceptionEkuatiaConfig({ RECEPTION_EKUATIA_ENABLED: 'yes' })).toThrow(
      'RECEPTION_EKUATIA_ENABLED must be true or false.',
    );
  });

  it('is available only when enabled AND the solver key is present', () => {
    const key = { TWOCAPTCHA_API_KEY: ' secret-key-value ' };
    expect(loadReceptionEkuatiaConfig({ ...key }).available).toBe(false);
    expect(loadReceptionEkuatiaConfig({ RECEPTION_EKUATIA_ENABLED: 'true' }).available).toBe(false);
    const both = loadReceptionEkuatiaConfig({ ...key, RECEPTION_EKUATIA_ENABLED: 'true' });
    expect(both.available).toBe(true);
    expect(both.solverApiKey).toBe('secret-key-value');
  });

  it('treats a blank key as absent', () => {
    expect(
      loadReceptionEkuatiaConfig({ TWOCAPTCHA_API_KEY: '  ', RECEPTION_EKUATIA_ENABLED: 'true' })
        .solverApiKey,
    ).toBeNull();
  });

  it('reads and trims every tunable', () => {
    expect(
      loadReceptionEkuatiaConfig({
        RECEPTION_EKUATIA_DAILY_SOLVE_CAP: ' 7 ',
        RECEPTION_EKUATIA_GLOBAL_DAILY_SOLVE_CAP: '42',
        RECEPTION_EKUATIA_BREAKER_FAILURES: '3',
        RECEPTION_EKUATIA_BREAKER_COOLDOWN_MS: '60000',
        EKUATIA_BASE_URL: 'https://ekuatia.example/',
        EKUATIA_RECAPTCHA_SITEKEY: 'sitekey-abc-0123456789-xyz',
      }),
    ).toMatchObject({
      tenantDailySolveCap: 7,
      globalDailySolveCap: 42,
      breakerFailureThreshold: 3,
      breakerCooldownMs: 60_000,
      baseUrl: 'https://ekuatia.example',
      sitekey: 'sitekey-abc-0123456789-xyz',
    });
  });

  it.each([
    ['RECEPTION_EKUATIA_DAILY_SOLVE_CAP', '0'],
    ['RECEPTION_EKUATIA_DAILY_SOLVE_CAP', '1.5'],
    ['RECEPTION_EKUATIA_DAILY_SOLVE_CAP', '100001'],
    ['RECEPTION_EKUATIA_DAILY_SOLVE_CAP', 'abc'],
    ['RECEPTION_EKUATIA_GLOBAL_DAILY_SOLVE_CAP', '0'],
    ['RECEPTION_EKUATIA_GLOBAL_DAILY_SOLVE_CAP', '1000001'],
    ['RECEPTION_EKUATIA_BREAKER_FAILURES', '0'],
    ['RECEPTION_EKUATIA_BREAKER_FAILURES', '101'],
    ['RECEPTION_EKUATIA_BREAKER_COOLDOWN_MS', '999'],
    ['RECEPTION_EKUATIA_BREAKER_COOLDOWN_MS', '86400001'],
    ['EKUATIA_BASE_URL', 'http://ekuatia.example'],
    ['EKUATIA_BASE_URL', 'not a url'],
    ['EKUATIA_RECAPTCHA_SITEKEY', 'has space'],
  ])('rejects %s=%j and names the variable, never the value', (name, value) => {
    let message = '';
    try {
      loadReceptionEkuatiaConfig({ [name]: value });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(name);
    expect(message).not.toContain(value === '' ? '\u0000' : `=${value}`);
  });

  it('rejects a tenant cap above the global cap, which could never be reached', () => {
    expect(() =>
      loadReceptionEkuatiaConfig({
        RECEPTION_EKUATIA_DAILY_SOLVE_CAP: '50',
        RECEPTION_EKUATIA_GLOBAL_DAILY_SOLVE_CAP: '10',
      }),
    ).toThrow('RECEPTION_EKUATIA_DAILY_SOLVE_CAP must not exceed');
  });
});
