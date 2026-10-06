import type { Database } from '@sifen/db';
import type { CertificateAccess, OpenedCertificate } from './certificate-vault.js';

type Environment = 'test' | 'production';

/**
 * Short on purpose (ADR-0009: "TTL corto"): it only bounds how long plaintext key material sits in
 * the worker's memory, because staleness is handled by the status re-check on every hit.
 */
export const DEFAULT_CERTIFICATE_CACHE_TTL_MS = 300_000;
/** One entry per (tenant, environment) the worker signs for; a few KiB each. */
export const DEFAULT_CERTIFICATE_CACHE_MAX_ENTRIES = 64;

/** What the cache needs from `CertificateVault`. */
export interface CertificateBackend {
  open(
    db: Database,
    tenantId: string,
    environment: Environment,
    access: CertificateAccess,
  ): Promise<OpenedCertificate>;
  /** The active, currently valid fingerprint, or null; never decrypts or audits. */
  currentFingerprint(
    db: Database,
    tenantId: string,
    environment: Environment,
  ): Promise<string | null>;
}

export interface CertificateCacheOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
  /** How often an idle cache sweeps expired entries (default: the TTL, at most 30 s). */
  readonly sweepIntervalMs?: number;
}

interface Entry {
  readonly certificate: OpenedCertificate;
  readonly expiresAt: number;
}

/**
 * LRU + TTL cache of opened certificates (ADR-0009, HU-E3-02), wrapping `CertificateVault.open` so
 * the `certificate.accessed` audit happens on decrypt only, never on a hit.
 *
 * - Every hit re-checks the stored status (one indexed read, no KMS, no audit): a certificate
 *   revoked or replaced by the CLI (another process) is dropped on the very next signing, which is
 *   what the immediate-block decision requires. The TTL is therefore not a staleness bound.
 * - Callers receive copies (`SignDocument` zeroizes what it gets); the cache zeroizes its own
 *   buffer when it evicts, expires, invalidates or clears. The password is a JS string and cannot
 *   be wiped; it only lives as long as its entry.
 * - Expired entries are zeroized on every `open` (any tenant) and by an unref'd timer that runs only
 *   while the cache holds entries, so plaintext does not outlive its TTL by more than the sweep
 *   interval (30 s at most) even on an idle worker. `clear()` stops the timer.
 * - Inherent TOCTOU: the status check and the signing are not one atomic step, so a revoke that
 *   lands between them still lets that one in-flight signing finish with the key it already holds;
 *   the next signing is blocked. The same window exists without a cache between reading the
 *   certificate and using it.
 * - Nothing is logged and failed opens are never cached.
 */
export class CachedCertificateVault {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly sweepIntervalMs: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly backend: CertificateBackend,
    options: CertificateCacheOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_CERTIFICATE_CACHE_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_CERTIFICATE_CACHE_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
    this.sweepIntervalMs = options.sweepIntervalMs ?? Math.min(this.ttlMs, 30_000);
  }

  async open(
    db: Database,
    tenantId: string,
    environment: Environment,
    access: CertificateAccess,
  ): Promise<OpenedCertificate> {
    this.sweep();
    const key = `${tenantId}:${environment}`;
    const hit = this.entries.get(key);
    if (hit) {
      if (this.now() < hit.expiresAt) {
        const current = await this.backend.currentFingerprint(db, tenantId, environment);
        // Re-read the entry: another call may have replaced or dropped it while awaiting.
        if (current === hit.certificate.fingerprint && this.entries.get(key) === hit) {
          this.entries.delete(key);
          this.entries.set(key, hit); // most recently used
          return copy(hit.certificate);
        }
      }
      this.drop(key);
    }
    const opened = await this.backend.open(db, tenantId, environment, access);
    this.drop(key);
    this.entries.set(key, { certificate: opened, expiresAt: this.now() + this.ttlMs });
    this.ensureTimer();
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
    return copy(opened);
  }

  /** Drops (and zeroizes) one entry, e.g. after an in-process revoke. */
  invalidate(tenantId: string, environment: Environment): void {
    this.drop(`${tenantId}:${environment}`);
  }

  /** Drops and zeroizes everything and stops the sweep timer (shutdown). */
  clear(): void {
    for (const key of [...this.entries.keys()]) this.drop(key);
    this.stopTimer();
  }

  /** Zeroizes every entry past its TTL. Cheap: the cache is bounded by `maxEntries`. */
  sweep(): void {
    const now = this.now();
    for (const [key, entry] of [...this.entries]) {
      if (now >= entry.expiresAt) this.drop(key);
    }
    if (this.entries.size === 0) this.stopTimer();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sweep();
    }, this.sweepIntervalMs);
    this.timer.unref();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private drop(key: string): void {
    this.entries.get(key)?.certificate.p12.fill(0);
    this.entries.delete(key);
  }
}

function copy(certificate: OpenedCertificate): OpenedCertificate {
  return { ...certificate, p12: Buffer.from(certificate.p12) };
}
