# HU-E3-01 (slice 2) — Store the tenant's .p12 sealed

## Objective

Persist a tenant's PKCS#12 certificate sealed with the custody envelope (ADR-0009), after the merged
inspector/validator accepted it (`inspectPkcs12` + `validateTenantCertificate`, ADR-0010, plan §8.7),
and expose it in memory only to the signing flow (unblocks HU-E6-02 S4 `SignDocument`).
Never commit real certificates; tests use `apps/api/test/support/test-pki.ts`.

## Settings

- TDD: strict (RED commit alone, GREEN, refactor). Runner: vitest (`@sifen/db`, `@sifen/api`).
- Delivery: stacked branches, each <= 400 changed lines. Migration number 0026 (0025 is PR #103, so the
  db branch is stacked on it).

## Slices (stacked branches)

- [x] **A — `feat/hu-e3-01-certs-db`: migration 0026 + schema + db specs.** `tenant_certificates`
      (`tenant_id`, `environment`, `sealed jsonb`, `fingerprint` sha-256 hex of the certificate DER,
      `subject_ruc`, `not_before`, `not_after`, `status` active|revoked, `revoked_at`, `created_at`),
      FORCE RLS, partial unique index (one `active` per tenant + environment), immutability trigger
      (only `status`/`revoked_at` change, active -> revoked only), no DELETE.
- [x] **B — `feat/hu-e3-01-certificate-vault`: `CertificateVault` + trusted roots loader.**
      `add` (inspect + validate against the tenant's fiscal-profile RUC and the PSC roots, seal, insert;
      optional replace revokes the previous active one in the same transaction), `open` (key+cert in
      memory, tenant RLS scope, AAD = tenant/kind/environment/version/fingerprint), `loadTrustedRoots`
      (PEM bundle from `PSC_TRUSTED_ROOTS_PATH`, fail closed when absent/empty).
- [x] **C — `feat/hu-e3-01-certificate-add-cli`: `certificate:add`.** `--tenant --env --p12 <path>
      --password -` (password read from stdin, never argv), `--replace`; invalid certificates refused
      with every validator reason; docs in the README "Operación" section.

## Decisions

- Grants mirror `tenant_cscs`: `app_user` SELECT only (the signing flow reads under the tenant's RLS
  scope and can never write or revoke); `platform_admin` SELECT, INSERT, UPDATE (the operator CLI adds
  and revokes; UPDATE is needed only for `status`/`revoked_at`, enforced by the trigger). No DELETE:
  certificates are kept as a record of what signed documents.
- The sealed payload is `{ p12, password }` (JSON, base64 p12): the signer needs both
  (`LoadedCertificate`), and the `.p12` password must not sit next to the blob in clear.
- AAD context: `kind: 'certificate'`, `version: 1`, `label: fingerprint`, so a blob cannot be swapped
  between rows, tenants, environments or certificates.
- Trusted PSC roots come from configuration (`PSC_TRUSTED_ROOTS_PATH`, PEM bundle), never hardcoded
  (validator contract). The CLI refuses to run `certificate:add` without it.
