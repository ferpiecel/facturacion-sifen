import { createHash } from 'node:crypto';

export interface CertificateExpirySource {
  readonly certificateId: string;
  readonly environment: string;
  readonly fingerprint: string;
  readonly notAfter: Date;
  readonly thresholdDays: number;
  readonly daysRemaining: number;
}

/** HU-E3-03: deterministic per (certificate, threshold), so the outbox's UNIQUE key dedupes the alert. */
export function certificateExpiryEventId(certificateId: string, thresholdDays: number): string {
  const key = `${certificateId}:certificate.expiring:${String(thresholdDays)}`;
  return `evt_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
}

/** Public facts only (the fingerprint is not secret); never the sealed `.p12` or its password. */
export function certificateExpiryData(source: CertificateExpirySource): Record<string, unknown> {
  return {
    certificate_id: source.certificateId,
    environment: source.environment,
    fingerprint: source.fingerprint,
    not_after: source.notAfter.toISOString(),
    threshold_days: source.thresholdDays,
    days_remaining: source.daysRemaining,
  };
}
