import { describe, expect, it } from 'vitest';
import {
  SIGNATURE_HEADER,
  SIGNATURE_TOLERANCE_SECONDS,
  generateWebhookSecret,
  signWebhook,
  verifyWebhookSignature,
} from './webhook-signature.js';

const secret = 'whsec_test-secret';
const body = '{"id":"evt_1"}';
const t = 1_790_000_000;

describe('webhook signature (HU-E11-01, ADR-0011)', () => {
  it('uses the Sifen-Signature header and the 5 minute anti-replay window', () => {
    expect(SIGNATURE_HEADER).toBe('Sifen-Signature');
    expect(SIGNATURE_TOLERANCE_SECONDS).toBe(300);
  });

  it('signs "<t>.<body>" with HMAC-SHA256 as t=<unix>,v1=<hex>', () => {
    // openssl: printf '1790000000.{"id":"evt_1"}' | openssl dgst -sha256 -hmac whsec_test-secret
    expect(signWebhook({ secret, body, timestamp: t })).toMatch(/^t=1790000000,v1=[0-9a-f]{64}$/);
    expect(signWebhook({ secret, body, timestamp: t })).toBe(
      signWebhook({ secret, body, timestamp: t }),
    );
  });

  it('accepts a valid signature within tolerance', () => {
    const header = signWebhook({ secret, body, timestamp: t });
    expect(verifyWebhookSignature({ secret, body, header, now: t + 299 })).toEqual({ ok: true });
  });

  it('rejects a replayed (too old) or future-dated delivery', () => {
    const header = signWebhook({ secret, body, timestamp: t });
    expect(verifyWebhookSignature({ secret, body, header, now: t + 301 })).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(verifyWebhookSignature({ secret, body, header, now: t - 301 })).toEqual({
      ok: false,
      reason: 'stale',
    });
  });

  it('rejects a tampered body, a wrong secret and a tampered timestamp', () => {
    const header = signWebhook({ secret, body, timestamp: t });
    const check = (o: object) => verifyWebhookSignature({ secret, body, header, now: t, ...o }).ok;
    expect(check({ body: `${body} ` })).toBe(false);
    expect(check({ secret: 'whsec_other' })).toBe(false);
    expect(check({ header: header.replace(`t=${String(t)}`, `t=${String(t + 1)}`) })).toBe(false);
  });

  it.each([
    '',
    'garbage',
    't=abc,v1=00',
    `t=${String(t)}`,
    `v1=${'0'.repeat(64)}`,
    `t=${String(t)},v1=zz`,
  ])('rejects the malformed header %j', (header) => {
    expect(verifyWebhookSignature({ secret, body, header, now: t })).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'fails closed on a non-finite or negative tolerance (%s)',
    (toleranceSeconds) => {
      const header = signWebhook({ secret, body, timestamp: t });
      expect(verifyWebhookSignature({ secret, body, header, now: t, toleranceSeconds }).ok).toBe(
        false,
      );
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'fails closed on a non-finite clock (%s)',
    (now) => {
      const header = signWebhook({ secret, body, timestamp: t });
      expect(verifyWebhookSignature({ secret, body, header, now }).ok).toBe(false);
    },
  );

  it('rejects a duplicated t and an oversized header as malformed', () => {
    const header = signWebhook({ secret, body, timestamp: t });
    expect(
      verifyWebhookSignature({ secret, body, header: `t=${String(t + 1)},${header}`, now: t }),
    ).toMatchObject({ ok: false, reason: 'malformed' });
    const huge = `${header}${',v1=00'.repeat(400)}`;
    expect(huge.length).toBeGreaterThan(2048);
    expect(verifyWebhookSignature({ secret, body, header: huge, now: t })).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
  });

  it('splits key and value on the first "=" only', () => {
    const header = signWebhook({ secret, body, timestamp: t });
    const poisoned = header.replace(/v1=/, 'v1=0=');
    expect(verifyWebhookSignature({ secret, body, header: poisoned, now: t })).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
  });

  it('supports secret rotation: signs with several secrets, any one verifies', () => {
    const header = signWebhook({ secret: ['whsec_new', 'whsec_old'], body, timestamp: t });
    expect(header.match(/v1=/g)).toHaveLength(2);
    for (const s of ['whsec_new', 'whsec_old']) {
      expect(verifyWebhookSignature({ secret: s, body, header, now: t }).ok).toBe(true);
    }
    expect(verifyWebhookSignature({ secret: ['x', 'whsec_old'], body, header, now: t }).ok).toBe(
      true,
    );
  });

  it('generates a prefixed, high-entropy, unique secret', () => {
    const a = generateWebhookSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(generateWebhookSecret()).not.toBe(a);
  });
});
