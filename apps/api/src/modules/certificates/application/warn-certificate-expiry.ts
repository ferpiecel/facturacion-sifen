import { dueAlertThreshold } from '../domain/certificate-expiry.js';
import type {
  CertificateExpiryAlert,
  CertificateExpiryStore,
} from './ports/certificate-expiry-store.port.js';

const DAY_MS = 86_400_000;

export interface WarnCertificateExpiryDeps {
  readonly store: CertificateExpiryStore;
  readonly now: () => Date;
  /** Days before expiry, descending (`parseAlertDays`). */
  readonly thresholdsDays: readonly number[];
}

/**
 * HU-E3-03: one pass of the expiry watch for a tenant. A certificate that crossed a threshold and has
 * not expired gets that threshold's alert. Running it again is harmless: the store never repeats a
 * (certificate, threshold) alert.
 */
export class WarnCertificateExpiry {
  constructor(private readonly deps: WarnCertificateExpiryDeps) {}

  async run(): Promise<{ alerted: number }> {
    const now = this.deps.now();
    const alerts: CertificateExpiryAlert[] = [];
    for (const cert of await this.deps.store.findActive()) {
      const thresholdDays = dueAlertThreshold(cert.notAfter, now, this.deps.thresholdsDays);
      if (thresholdDays === undefined) continue;
      alerts.push({
        certificateId: cert.id,
        environment: cert.environment,
        fingerprint: cert.fingerprint,
        notAfter: cert.notAfter,
        thresholdDays,
        daysRemaining: Math.floor((cert.notAfter.getTime() - now.getTime()) / DAY_MS),
      });
    }
    if (alerts.length > 0) await this.deps.store.enqueue(alerts, now);
    return { alerted: alerts.length };
  }
}
