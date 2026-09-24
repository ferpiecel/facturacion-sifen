```yaml
change: f0-tips-poc-offline
mode: full-artifacts
strict_tdd: true
verdict: PASS WITH WARNINGS
requirements_total: 6
scenarios_total: 9
scenarios_passing: 9
tasks_total: 95
tasks_complete: 95
critical_count: 0
warning_count: 3
suggestion_count: 0
commands:
  - cmd: "rm -rf packages/*/dist apps/*/dist"
    exit: 0
  - cmd: "npx --yes pnpm@12.5.1 install --frozen-lockfile"
    exit: 0
  - cmd: "npx --yes pnpm@12.5.1 turbo run format:check lint typecheck depcruise test build verify-vendor --force"
    exit: 0
    result: "25/25 tasks successful (0 cached), 5.467s"
```

## Verification Report — f0-tips-poc-offline

**Mode**: full artifacts (proposal, specs, design, tasks, apply-progress present)
**Verdict**: PASS WITH WARNINGS

### Completeness
95/95 tasks `[x]` in `tasks.md`, matches two apply-progress sessions (Phases 1-4 PR1/PR2a; Phases 5-7 PR2b) with TDD RED→GREEN commits.

### Runtime evidence
Full clean-state run: `rm -rf packages/*/dist apps/*/dist && pnpm install --frozen-lockfile && pnpm turbo run format:check lint typecheck depcruise test build verify-vendor --force` → **25/25 tasks green**, 0 cached. `sifen-gateway` 33 tests, `sifen-tips` 17 tests (incl. e2e `poc-offline.e2e.spec.ts`), `sifen-xsd` 20 tests, `api` 21 tests, `config` static checks — all pass.

### Spec compliance matrix

| Requirement | Scenario | Evidence | Status |
|---|---|---|---|
| DeXmlBuilder port shape | Port module has no framework/TIPS imports | `emission-ports-boundaries.spec.ts`, root depcruise rule | PASS |
| DeXmlBuilder port shape | Built XML validates against siRecepDE | `poc-offline.e2e.spec.ts` L66-67 | PASS |
| XmlSigner port shape | Signature algorithms/structure | `poc-offline.e2e.spec.ts` L74-76 (exc-c14n, rsa-sha256, sha256, KeyInfo, Reference URI) | PASS |
| XmlSigner port shape | Signer never spawns JVM | no-subprocess guard, `getGuardCallCount()===0` in e2e | PASS |
| QrGenerator port shape | QR URL test base + IdCSC=0001 | `poc-offline.e2e.spec.ts` L105-111 | PASS |
| XmlSigner adapter forces Node-mode | Node-mode flag always set | `xml-signer.spec.ts` (3 tests) | PASS |
| Dev certificate ephemeral | Cert generated at test time, no repo fixture | `dev-certificate.spec.ts`; `git ls-files` has no `.p12` | PASS |
| Offline PoC e2e flow | Full offline flow succeeds | `poc-offline.e2e.spec.ts` (5 tests), no-network/no-JVM | PASS |
| Offline PoC e2e flow | FakeSifenGateway receives signed XML | `poc-offline.e2e.spec.ts` L114-120, via `enviarLote`/`0300` | PASS (see WARNING) |

9/9 scenarios covered by passing runtime tests.

### TDD Compliance
RED→GREEN evidence reported per task (1.2/1.5, 4.1/4.3/4.5, 5.1/5.2, dev-certificate, no-subprocess-guard) with separate red/green commits; cross-checked against current green run. No tautologies or ghost-loop assertions found in reviewed test files.

### Issues

**WARNING**
1. Spec text mismatch: `sifen-tips-adapters/spec.md` scenario "FakeSifenGateway receives the signed XML" still names `enviarDESincronico`/0260, but the passing e2e test exercises `enviarLote`/0300 per explicit apply-time scope override. Spec prose needs a follow-up edit or documented rationale — accepted deviation per session brief.
2. PR #18 exceeds the stated ≤300 hand-written-line target (367 lines) — accepted `size:exception` per session brief and tasks.md rationale.
3. ADR-0015 D7 (`dSisFact`) and D8 (two transforms) remain open pending `sifen-test`/Prevalidador confirmation — accepted known-pending item, not a defect in this PoC scope.

**CRITICAL**: none.
**SUGGESTION**: none.

### Scope note
Real `sifen-test` PoC (network) is out of scope, blocked on PO credentials, per session brief — offline PoC fully substitutes for this slice's stated goal.
