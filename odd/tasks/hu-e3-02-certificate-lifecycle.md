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
- [ ] **S2 — audited certificate access:** `certificate.added`/`certificate.replaced` audit in
      `CertificateVault.add` and `certificate.accessed` (fingerprint only, actor = signing flow) in `open`.
- [ ] **S3 — LRU + TTL cache** in front of `open` (short TTL, bounded size, zeroize on eviction and on
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

## Open product question (reported, not decided)

Revoking the only active certificate blocks signing at once (documents are held as
`signing:CertificateNotFoundError` and released with `document:release-holds` after a new `certificate:add`).
Whether that is the desired immediate effect, or a grace period is wanted, is a product call.

## Progress

- S1: RED 0a60b7d (6 failing specs: unknown subcommand), GREEN in the next commit. No migration needed.
