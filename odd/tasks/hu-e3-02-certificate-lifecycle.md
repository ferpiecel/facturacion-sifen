# HU-E3-02 — Certificate lifecycle: revoke, audited access, cache

## Objective

Close the gaps between main and HU-E3-01/02 + ADR-0009/0010 for tenant certificates: an audited
`certificate:revoke` operator command, audited decrypt access, and the LRU cache with a short TTL.
Never commit real certificates; tests use `apps/api/test/support/test-pki.ts`.

## Settings

- TDD: strict (RED commit alone, then GREEN). Runner: vitest (`@sifen/api`, `@sifen/db` if touched).
- Delivery: one branch per slice, each <= 400 changed lines (generated snapshots excluded).
- Route: delegated writer (single), inline per task.

## Gap analysis (main at 0033)

1. Stored: sealed `.p12` + password (AES-256-GCM envelope, local KMS), RUC/EKU/expiry/PSC chain validated,
   FORCE RLS table, one `active` row per (tenant, environment) by partial unique index.
2. A second upload: refused (`ActiveCertificateExistsError`) unless `--replace`, which revokes the old row
   and inserts the new one in one transaction. Signing (`CertificateVault.open`) reads only
   `status = 'active'`, so it always uses the newest active certificate and never a revoked one.
3. Revoke path: only the implicit one inside `--replace` (no audit, no standalone command). The schema
   already supports it (`status`, `revoked_at`, guard trigger, `platform_admin` UPDATE grant): no
   migration is needed, so 0034 is not used.
4. Audit: nothing in the certificate path writes to `audit_log` (add, replace, decrypt are all silent),
   although ADR-0009 says every key access is audited.
5. Cache: no LRU/TTL; every signing decrypts through the KMS again.
6. Cloud KMS: not present; it plugs into `KeyManagementService`
   (`modules/custody/application/ports/key-management.port.ts`), next to `createLocalKms`. Out of scope
   here (needs provider credentials).

## Slices

- [x] **S1 — `feat/hu-e3-02-certificate-revoke`: `certificate:revoke` (this branch).**
  - [x] T1.1 `parseOpsArgs`: `certificate:revoke --tenant T (--id U | --fingerprint F) [--env E]`.
  - [x] T1.2 `revokeCertificate` handler: tenant-scoped, idempotent (already revoked: no change, no new
        audit row, original `revoked_at` kept), unknown or other-tenant target is an error, fingerprint
        present in both environments requires `--env`, sealed blob never touched, audit
        `certificate.revoked` in the same transaction.
  - [x] T1.3 `runOpsCommand`/`runCli` wiring (no KMS key or vault needed) and README "Operación".
  - [x] T1.4 Signing refuses a revoked certificate: covered by a regression test (`CertificateNotFoundError`
        from `open`, the transmission pipeline already holds the document as `signing:CertificateNotFoundError`).
- [x] **S2 — `feat/hu-e3-02-certificate-audit`, audited certificate access:** `certificate.added`/`certificate.replaced` audit in
      `CertificateVault.add` and `certificate.accessed` (fingerprint only, actor = signing flow) in `open`.
- [x] **S3 — `feat/hu-e3-02-certificate-cache`, LRU + TTL cache** in front of `open` (short TTL, bounded size, zeroize on eviction and on
      revoke; revoke must invalidate or the TTL bounds the exposure, to be decided with S2 evidence).
- [ ] **S4 (separate story) — cloud KMS adapter** behind `KeyManagementService`.

## Acceptance criteria (S1)

- `certificate:revoke` by id or by fingerprint sets `status = 'revoked'` and `revoked_at`, keeps `sealed`.
- Running it again exits 0 and changes nothing (idempotent).
- Another tenant's certificate id is "not found"; nothing is revoked.
- One `certificate.revoked` audit row per effective revocation, with ids and public facts only.
- After revoking, `CertificateVault.open` throws `CertificateNotFoundError`.

## Checks

In `apps/api`: `tsc --noEmit -p tsconfig.json`, `run lint`, `exec depcruise src --config
.dependency-cruiser.cjs`, `exec vitest run --coverage` (85%). `packages/db` only if touched.

## Decision (tech lead, security/compliance)

Revocation blocks signing immediately, with no grace period. Revocation is for compromised or replaced
certificates. Documents are held as `signing:CertificateNotFoundError` until a new `certificate:add`
and `document:release-holds`.

## Progress

- S1: RED 0a60b7d (6 failing specs: unknown subcommand), GREEN in the next commit. No migration needed.
- S2: RED 064638c (4 failing specs: added, replaced+revoked, accessed, fail-closed; the leftover revoke
  cases and the two "writes nothing" specs already passed as regression guards), GREEN in the next commit.
  No migration (0034 belongs to HU-E6-04; 0035 would be next if one were ever needed).

## S2 decisions

- `certificate.added` / `certificate.replaced` + `certificate.revoked` (old one) are written in the same
  `db.transaction` as the insert/update, with `app.current_tenant` bound for `recordAudit`.
- `certificate.accessed` is written inside the tenant transaction of `open`, after validity checks (no
  usable certificate, no row) and committed before the key is touched. Row content: fingerprint,
  environment and purpose only; actor is passed by the caller (worker: `system/transmission-worker`).
- Anti-flood: audit on decrypt only, never on a cache hit. The audit lives inside `open`, so the S3 cache
  must wrap `open` (cache miss = decrypt = one audit row); with a TTL the volume is about one row per
  tenant per environment per TTL instead of one per signed document. Until S3, it is one row per signing.
- Fail-closed: ADR-0009 says every key access is audited, so if the audit insert fails `open` throws
  before decrypting. The failure is a plain error (not in the deterministic-signing set), so the
  transmission cycle does not park the document: it is retried next cycle.
- Audit payload keys avoid `certificate*` names (the redactor masks them): `previousId`, not `certificateId`.

## S3 decisions

- `CachedCertificateVault` wraps `open` (the worker wires it); the audit stays inside the vault's decrypt,
  so only misses are audited. Defaults: TTL 5 min, 64 entries (env `CERTIFICATE_CACHE_TTL_MS` 1 s..15 min,
  `CERTIFICATE_CACHE_MAX_ENTRIES` 1..1000). A worker signs for a bounded set of (tenant, env) pairs, each
  entry is a few KiB, and 5 min keeps plaintext residency short (ADR-0009) while collapsing a cycle's
  per-document decrypts into one.
- Staleness across processes (CLI revoke vs worker): every hit re-checks the stored status with one indexed
  read (`currentFingerprint`: active, in validity window, same fingerprint; no KMS, no audit). Revoke,
  replace and expiry therefore block the next signing, matching the immediate-block decision; the TTL is
  not a staleness bound. Rejected: TTL-only (up to 5 min of signing with a revoked key), cross-process
  pub/sub (new infrastructure).
- Callers get copies (`SignDocument` zeroizes its buffer); the cache zeroizes its own on
  eviction/expiry/invalidate/clear. The password is a JS string: not wipeable, bounded by the entry life.
- No logging in the cache; failed opens are never cached. No single-flight (the tenant run lock already
  serializes a tenant's cycle).


### S3 review fixes

- Expiry was lazy-only, so an idle tenant's plaintext outlived the TTL. Chosen: sweep on every `open`
  (any tenant) plus an unref'd interval that only runs while the cache holds entries and is cancelled by
  `clear()`. A sweep on `open` alone would not help an idle worker (no calls), and a permanent interval
  would keep an empty cache's timer alive; the lazily started one covers both. Bound: plaintext lives at
  most TTL + sweep interval (<= 30 s). The worker keeps the cache instance and calls `clear()` on shutdown
  (after `running.stop()`); that wiring is in the untested process entrypoint.
- Documented the inherent TOCTOU between the status re-check and signing in the class docstring.
