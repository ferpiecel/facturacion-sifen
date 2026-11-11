import { describe, expect, it } from 'vitest';
import type {
  ActiveCertificate,
  CertificateExpiryAlert,
  CertificateExpiryStore,
} from './ports/certificate-expiry-store.port.js';
import { WarnCertificateExpiry } from './warn-certificate-expiry.js';

const DAY = 86_400_000;
const NOW = new Date('2026-12-01T12:00:00.000Z');
const cert = (id: string, daysLeft: number): ActiveCertificate => ({
  id,
  environment: 'production',
  fingerprint: id.padEnd(64, '0'),
  notAfter: new Date(NOW.getTime() + daysLeft * DAY),
});

function fakeStore(active: ActiveCertificate[]) {
  const enqueued: { alerts: readonly CertificateExpiryAlert[]; at: Date }[] = [];
  const store: CertificateExpiryStore = {
    findActive: () => Promise.resolve(active),
    enqueue: (alerts, at) => {
      enqueued.push({ alerts, at });
      return Promise.resolve();
    },
  };
  return { store, enqueued };
}

/** Spec: HU-E3-03. One pass of the expiry watch for a tenant. */
describe('WarnCertificateExpiry', () => {
  const run = (active: ActiveCertificate[], thresholds = [60, 30, 7]) => {
    const { store, enqueued } = fakeStore(active);
    const result = new WarnCertificateExpiry({ store, now: () => NOW, thresholdsDays: thresholds });
    return { result: result.run(), enqueued };
  };

  it('alerts a certificate that crossed a threshold with the closest one', async () => {
    const { result, enqueued } = run([cert('c1', 29.5)]);
    expect(await result).toEqual({ alerted: 1 });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].at).toEqual(NOW);
    expect(enqueued[0].alerts).toEqual([
      expect.objectContaining({
        certificateId: 'c1',
        environment: 'production',
        thresholdDays: 30,
        daysRemaining: 29,
      }),
    ]);
  });

  it('skips a certificate with more time left than the first threshold', async () => {
    const { result, enqueued } = run([cert('far', 200)]);
    expect(await result).toEqual({ alerted: 0 });
    expect(enqueued).toHaveLength(0);
  });

  it('skips an expired certificate: the emission block covers it', async () => {
    const { result, enqueued } = run([cert('gone', -1)]);
    expect(await result).toEqual({ alerted: 0 });
    expect(enqueued).toHaveLength(0);
  });

  it('uses the configured thresholds', async () => {
    const { result } = run([cert('c1', 13)], [14]);
    expect(await result).toEqual({ alerted: 1 });
  });
});
