# HU-E1-07 — MFA enrolment at first login

- Feature: `hu-e1-07-mfa-enrolment` · Refs: HU-E1-07, RF-13 · Engram mirror: `odd/hu-e1-07-mfa-enrolment/tasks`
- TDD: strict (project config) · runner: Vitest (`@sifen/db`, `@sifen/api`, `@sifen/web`)
- Delivery: two chained PRs, each <= 400 changed lines. Route: delegated direct (single writer).

## Objective

A user provisioned with `user:create` has no MFA. At first login the password opens a PENDING session and the user
enrols TOTP, receives 10 one-time recovery codes once, and is promoted to a verified session. Decisions 1 and 3 of
`hu-e1-07-portal-login.md` apply (MFA mandatory for every role; 10 recovery codes).

## Checklist

### PR 1 — API (`feat/hu-e1-07-mfa-enrolment-api`)

- [ ] T1 Migration 0045: `mfa_account`, `mfa_save_pending`, `mfa_confirm` SECURITY DEFINER functions bound to the pending
      session; `SqlMfaRuntimeStore` implements `savePending`, `confirm`, `account`.
- [ ] T2 `LoginService.beginEnrollment` resolves the account itself, throttles, audits, and answers `null` for an
      already-enrolled user.
- [ ] T3 `POST /auth/mfa/enroll`, `POST /auth/mfa/confirm`; login answers `mfa_enrollment_required` with the pending cookie.
- [ ] T4 e2e tests (enrol, confirm, recovery codes once, replay refused, already enrolled, verified session, CSRF).

### PR 2 — Portal (`feat/hu-e1-07-mfa-enrolment-web`, draft, depends on PR 1)

- [ ] T5 `auth-client` enroll/confirm calls and `mfa_enrollment_required` handling.
- [ ] T6 Enrolment screen (QR client-side, secret fallback, code input) and recovery-codes screen with acknowledgement.

## Acceptance

Enrolment is possible only for the PENDING session's own user; an enrolled user or a verified session gets the
uniform 401; recovery codes are returned exactly once; the otpauth URI never leaves the browser.
