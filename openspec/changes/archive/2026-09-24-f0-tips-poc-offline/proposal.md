# Proposal: Offline PoC with the TIPS libraries (HU-E0-04, offline part)

## Intent

ADR-0002 left xmlsign and qrgen "to be evaluated in the F0 PoC". The spike (engram `sifen/tips-libs-spike`) proved xmlgen + xmlsign (Node mode) + qrgen produce an FE that passes `siRecepDE` XSD validation. This change fixes that decision in ADR-0015, adds the missing domain ports, and locks the result with an offline end-to-end test.

## Scope

### In Scope
- Ports `DeXmlBuilder`, `XmlSigner`, `QrGenerator` in `@sifen/sifen-gateway` (framework-free, no TIPS types).
- New package `@sifen/sifen-tips`: adapters over xmlgen, xmlsign (always `signByNodeJS: true`), qrgen.
- Offline e2e PoC test: build test FE → sign with a test-time self-signed cert (never committed) → add QR (generic CSC, IdCSC 0001, test base URL) → validate with `@sifen/sifen-xsd` → send via `FakeSifenGateway` → assert signature structure (exc-c14n, rsa-sha256, sha256, KeyInfo X509Certificate only, Reference URI `#<DE Id>`).
- `docs/adr/0015-*.md` (Spanish, MADR) amending ADR-0002; record open questions D7 (dSisFact) and D8 (two transforms) and the own-signer fallback. Update `docs/adr/README.md` (0015 row; 0002 marked amended).

### Out of Scope
- Real SIFEN calls, setapi, mTLS, KuDE.
- Persistence and emission use cases (E5); certificate custody (ADR-0009).
- Resolving D7/D8 (needs sifen-test / Prevalidador).

## Capabilities

### New Capabilities
- `sifen-tips-adapters`: TIPS-backed adapters for the three ports, Node-only signing, and the offline PoC e2e contract.

### Modified Capabilities
- `sifen-gateway-contract`: add requirements for the `DeXmlBuilder`, `XmlSigner`, `QrGenerator` port shapes (framework-free, no TIPS type leakage).

## Approach

Hexagonal: ports in the contracts package, adapters in a separate package so only `@sifen/sifen-tips` depends on TIPS. Where official documents diverge, follow what SIFEN validates at runtime (the published XSD), per ADR-0012's Prevalidador confirmation step. Strict TDD: port/adapter tests written first (red → green).

Delivery (auto-chain, ≤400 hand-written lines each):
1. PR1: ports + ADR-0015 + README index.
2. PR2 (chained on PR1): `@sifen/sifen-tips` adapters + PoC e2e test.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/sifen-gateway/src/` | Modified | New port interfaces |
| `packages/sifen-tips/` | New | Adapters + PoC test |
| `docs/adr/0015-*.md`, `docs/adr/README.md` | New/Modified | ADR and index |
| `pnpm-lock.yaml` | Modified | TIPS dependencies |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| SIFEN rejects double transform (D8) | Med | Recorded in ADR-0015; own-signer fallback behind `XmlSigner` |
| dSisFact contradiction (D7) | Med | Follow runtime XSD; confirm in sifen-test |
| xmlsign falls back to JVM | Low | Adapter forces `signByNodeJS: true`; test asserts no JVM path |
| Community library drift | Low | Pinned versions, ports, contract tests |

## Rollback Plan

Revert PR2 (removes `@sifen/sifen-tips`, no consumers yet), then PR1 (ports are additive; ADR-0015 row removed, ADR-0002 restored to plain Accepted). No data or runtime migration involved.

## Dependencies

- `facturacionelectronicapy-xmlgen` 1.0.283, `-xmlsign` 1.0.28, `-qrgen`; existing `@sifen/sifen-xsd` and `FakeSifenGateway`.

## Success Criteria

- [x] PoC e2e test passes offline in CI, with no network and no JVM.
- [x] Signed FE with QR validates against `siRecepDE`.
- [x] Ports import no TIPS or framework modules.
- [x] ADR-0015 accepted and indexed; each PR ≤400 hand-written lines.
