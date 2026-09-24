# Delta for SIFEN Gateway Contract

## ADDED Requirements

### Requirement: DeXmlBuilder port shape

The system MUST expose a framework-free `DeXmlBuilder` port in `packages/sifen-gateway` that builds a signable FE XML document from application-level DE data, with no TIPS library types in its public signature.

#### Scenario: Port module has no framework or TIPS imports

- GIVEN the `DeXmlBuilder` port module source
- WHEN its imports are inspected
- THEN it MUST NOT import any TIPS library, `@nestjs/*`, `fastify`, `drizzle-orm`, or `bullmq`

#### Scenario: Built XML validates against siRecepDE

- GIVEN a `DeXmlBuilder` implementation and valid DE data
- WHEN `build` is called
- THEN the returned XML MUST validate against the `siRecepDE` XSD

### Requirement: XmlSigner port shape

The system MUST expose a framework-free `XmlSigner` port in `packages/sifen-gateway` that signs an FE XML document and MUST NOT leak TIPS library types through its signature.

#### Scenario: Signature uses required algorithms and structure

- GIVEN an `XmlSigner` implementation and an unsigned FE XML with element Id `<DE Id>`
- WHEN `sign` is called
- THEN the resulting `Signature` MUST use `exc-c14n` canonicalization and `rsa-sha256` signature method with `sha256` digest
- AND `KeyInfo` MUST contain only `X509Certificate`
- AND the `Reference` `URI` MUST equal `#<DE Id>`

#### Scenario: Signer never spawns a JVM process

- GIVEN an `XmlSigner` implementation
- WHEN `sign` is called
- THEN the implementation MUST NOT spawn a Java process

### Requirement: QrGenerator port shape

The system MUST expose a framework-free `QrGenerator` port in `packages/sifen-gateway` that produces a QR URL for a signed FE, with no TIPS types in its public signature.

#### Scenario: QR URL targets the test base URL with the generic CSC

- GIVEN a `QrGenerator` implementation, a signed FE, and CSC Id `0001`
- WHEN `generate` is called
- THEN the returned URL MUST start with the SIFEN test base URL
- AND the URL MUST include `IdCSC=0001`
