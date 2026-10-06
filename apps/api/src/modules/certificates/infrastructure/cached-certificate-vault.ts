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
 * - Nothing is logged and failed opens are never cached.
 */
export class CachedCertificateVault {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(
    private readonly backend: CertificateBackend,
    options: CertificateCacheOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_CERTIFICATE_CACHE_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_CERTIFICATE_CACHE_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  async open(
    db: Database,
    tenantId: string,
    environment: Environment,
    access: CertificateAccess,
  ): Promise<OpenedCertificate> {
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

  /** Drops and zeroizes everything (shutdown). */
  clear(): void {
    for (const key of [...this.entries.keys()]) this.drop(key);
  }

  private drop(key: string): void {
    this.entries.get(key)?.certificate.p12.fill(0);
    this.entries.delete(key);
  }
}

function copy(certificate: OpenedCertificate): OpenedCertificate {
  return { ...certificate, p12: Buffer.from(certificate.p12) };
}
