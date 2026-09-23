# Proposal: SIFEN gateway port and in-process fake (HU-E0-05, partial)

## Intent

Emission and transmission use cases (E5, E6) need a stable `SifenGateway` port and a deterministic test double that returns real SIFEN codes. Without them, application-layer tests either depend on `sifen-test` or invent codes. This change delivers the port contract and `FakeSifenGateway` now, so later use cases can be written test-first.

## Scope

### In Scope
- New framework-free package `packages/sifen-gateway`.
- `SifenGateway` port with the six operations of plan §5.1, keeping the Spanish names and `dId: bigint`: `enviarLote`, `consultarLote`, `enviarDESincronico`, `consultarDE`, `enviarEventos`, `consultarRUC`.
- Result/value types: `SifenLoteReceipt`, `SifenLoteResult`, `SifenProtocoloDE`, `SifenConsDE`, `SifenEventosResult`, `SifenConsRUC`.
- `SifenCode` catalog limited to verified codes: 0160, 0260, 0300, 0301, 0360, 0361, 0362, 0364, 0420, 0422.
- Typed errors: `SifenTimeoutError` and `SifenTransportError`.
- `FakeSifenGateway`: scenarios per operation (approve, reject with code and message, 0361, 0360, 0301, RUC blocked, timeout, transport error), call recording, no timers.
- The `enviarEventos` limit of 15 events is enforced by the fake.
- A dependency-cruiser rule that stops the package from importing frameworks.

### Out of Scope
- SOAP adapter and the TIPS `setapi` integration (E6).
- HTTP SOAP mock in docker-compose. It is deferred, so HU-E0-05 stays partial.
- XML generation, signing, persistence, retries.
- Codes that the `docs/referencia/dnit/` text does not verify.

## Capabilities

### New Capabilities
- `sifen-gateway-contract`: the port, result types, code catalog, typed errors and fake scenario/recording behavior.

### Modified Capabilities
- `architecture-boundaries`: add a requirement that `packages/sifen-gateway/` MUST NOT import `@nestjs/*`, `fastify`, `drizzle-orm` or `bullmq`. Today's rules only cover `modules/*/(domain|application)/`.

## Approach

Strict TDD. Types come first, then fake scenarios are driven by tests. A scenario is configured per operation (queue or default), and each call is recorded with its arguments. A timeout is a rejected promise carrying `SifenTimeoutError`, with no sleeping. The package layout mirrors `packages/sifen-xsd`. ADR-0003 (hexagonal, framework-free ports), ADR-0007 (the worker consumes the same port) and ADR-0012 (notas técnicas over MT for code meanings) apply.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/sifen-gateway/` | New | Port, types, codes, errors, fake, tests |
| `.dependency-cruiser.cjs` | Modified | Framework-free rule for the package |
| `pnpm-workspace` / CI | Modified | Package picked up by lint/test/typecheck |

## PR Slicing

1. Port, types, codes, errors and the dependency-cruiser rule (~150 lines).
2. `FakeSifenGateway` and its scenario tests (~200 lines), stacked on PR 1.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Port shape drifts when the real adapter arrives | Med | Keep result types minimal and version them when E6 starts |
| A code meaning is wrong | Low | Only the verified table, with MT/Guía references in JSDoc |
| The dependency-cruiser scan does not include `packages/` | Med | Add a failing-fixture test for the rule |

## Rollback Plan

Revert the squash commits (PR 2, then PR 1). Nothing consumes the package yet, and there is no data or schema impact.

## Dependencies

- None at runtime. It follows the `packages/sifen-xsd` workspace conventions.

## Success Criteria

- [ ] Every operation has a fake scenario test with a verified code, and all pass in CI.
- [ ] The package has zero framework imports, and dependency-cruiser fails on a forbidden import.
- [ ] Each PR changes 400 lines or fewer.
