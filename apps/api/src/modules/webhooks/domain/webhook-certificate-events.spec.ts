import { describe, expect, it } from 'vitest';
import { createWebhookEvent } from './webhook-event.js';
import { certificateExpiryData, certificateExpiryEventId } from './webhook-certificate-events.js';

const CERT = '8d1f2b6e-5c1c-4d1c-9c7e-3b0a4f2e9a11';
const SOURCE = {
  certificateId: CERT,
  environment: 'production',
  fingerprint: 'a'.repeat(64),
  notAfter: new Date('2027-01-01T00:00:00.000Z'),
  thresholdDays: 30,
  daysRemaining: 29,
};

/** Spec: HU-E3-03. One alert per (certificate, threshold). */
describe('certificate expiry events', () => {
  it('has a deterministic id per certificate and threshold', () => {
    expect(certificateExpiryEventId(CERT, 30)).toBe(certificateExpiryEventId(CERT, 30));
    expect(certificateExpiryEventId(CERT, 30)).not.toBe(certificateExpiryEventId(CERT, 7));
    expect(certificateExpiryEventId(CERT, 30)).not.toBe(
      certificateExpiryEventId('00000000-0000-4000-8000-000000000000', 30),
    );
  });

  it('builds an id the event envelope accepts', () => {
    const event = createWebhookEvent({
      id: certificateExpiryEventId(CERT, 30),
      type: 'certificate.expiring',
      createdAt: new Date('2026-12-02T00:00:00.000Z'),
      tenantId: 't',
      data: certificateExpiryData(SOURCE),
    });
    expect(event.type).toBe('certificate.expiring');
  });

  it('carries public facts only: no sealed material', () => {
    expect(certificateExpiryData(SOURCE)).toEqual({
      certificate_id: CERT,
      environment: 'production',
      fingerprint: 'a'.repeat(64),
      not_after: '2027-01-01T00:00:00.000Z',
      threshold_days: 30,
      days_remaining: 29,
    });
  });
});
