# SIFEN TIPS Adapters Specification

## Purpose

Define TIPS-library-backed adapters for `DeXmlBuilder`, `XmlSigner`, and `QrGenerator` in package `@sifen/sifen-tips`, and the offline end-to-end PoC contract that locks the FE build/sign/QR/validate/send flow without network or JVM dependencies.

## Requirements

### Requirement: XmlSigner adapter forces Node-mode signing

The `@sifen/sifen-tips` `XmlSigner` adapter MUST call the underlying xmlsign library with `signByNodeJS: true` on every invocation and MUST NOT fall back to JVM-based signing.

#### Scenario: Node-mode flag is always set

- GIVEN the TIPS-backed `XmlSigner` adapter
- WHEN `sign` is called
- THEN the adapter MUST invoke xmlsign with `signByNodeJS` equal to `true`
- AND no Java process MUST be spawned during the call

### Requirement: Dev certificate is generated at test time and never committed

The offline PoC test MUST generate a self-signed development certificate at test-run time and MUST NOT read or reference a committed certificate file.

#### Scenario: Certificate is ephemeral

- GIVEN the offline PoC test suite runs
- WHEN the test signs the FE
- THEN the signing certificate MUST be generated during that test run
- AND no `.p12` or certificate file MUST exist in the repository as a fixture for this test

### Requirement: Offline PoC end-to-end flow

The offline PoC test MUST build a test FE, sign it, attach a QR, validate the signed document against `siRecepDE`, and send it through `FakeSifenGateway`, all without network access.

#### Scenario: Full offline flow succeeds

- GIVEN a test FE payload, an ephemeral dev certificate, and CSC Id `0001`
- WHEN the PoC runs `DeXmlBuilder.build`, then `XmlSigner.sign`, then `QrGenerator.generate`
- THEN the resulting document MUST validate against `siRecepDE`
- AND the test MUST make no network requests

#### Scenario: FakeSifenGateway receives the signed XML

- GIVEN a signed and QR-annotated FE from the PoC flow
- WHEN the PoC calls `FakeSifenGateway.enviarLote` returning `0300`
- THEN the fake's recorded call MUST include the exact signed XML string sent
