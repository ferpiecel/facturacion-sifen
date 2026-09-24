# SIFEN Gateway Contract Specification

## Purpose

Define the `SifenGateway` port, its result types, the verified `SifenCode` catalog, typed errors, and the deterministic `FakeSifenGateway` test double, so application-layer tests can exercise transmission flows without a real SIFEN connection.

## Requirements

### Requirement: SifenGateway port shape

The system MUST expose a framework-free `SifenGateway` port in `packages/sifen-gateway` with the six operations `enviarLote`, `consultarLote`, `enviarDESincronico`, `consultarDE`, `enviarEventos`, and `consultarRUC`, using the Spanish operation and field names from the plan, including `dId: bigint`.

#### Scenario: Port module has no framework imports

- GIVEN the `packages/sifen-gateway` package source
- WHEN its imports are inspected
- THEN it MUST NOT import `@nestjs/*`, `fastify`, `drizzle-orm`, or `bullmq`

### Requirement: enviarLote scenarios

`FakeSifenGateway.enviarLote` MUST return a `SifenLoteReceipt` with code 0300 and a lote number by default, and MUST support a configured scenario that returns code 0301 indicating the lote was not queued.

#### Scenario: Default enviarLote is accepted

- GIVEN a `FakeSifenGateway` with no scenario configured for `enviarLote`
- WHEN `enviarLote` is called with a batch of DEs
- THEN it MUST resolve with `SifenLoteReceipt.dCodRes` equal to `"0300"`
- AND the result MUST include a lote number

#### Scenario: Configured enviarLote is not queued

- GIVEN a `FakeSifenGateway` configured with the `0301` scenario for `enviarLote`
- WHEN `enviarLote` is called
- THEN it MUST resolve with `SifenLoteReceipt.dCodRes` equal to `"0301"`

### Requirement: consultarLote scenarios

`FakeSifenGateway.consultarLote` MUST support scripting a sequence of responses per lote number, an unknown-lote response, and an extemporaneous-query response.

#### Scenario: Lote in processing then concluded

- GIVEN a `FakeSifenGateway` configured with `consultarLote` scripted as `["0361", "0362"]` for a lote number
- WHEN `consultarLote` is called twice in order with that lote number
- THEN the first call MUST resolve with `dCodRes` equal to `"0361"`
- AND the second call MUST resolve with `dCodRes` equal to `"0362"`

#### Scenario: Unknown lote number

- GIVEN a `FakeSifenGateway` with no scenario configured for a given lote number
- WHEN `consultarLote` is called with that lote number
- THEN it MUST resolve with `dCodRes` equal to `"0360"`

#### Scenario: Extemporaneous lote query

- GIVEN a `FakeSifenGateway` configured with the `0364` scenario for a lote number
- WHEN `consultarLote` is called with that lote number
- THEN it MUST resolve with `dCodRes` equal to `"0364"`

### Requirement: consultarDE scenarios

`FakeSifenGateway.consultarDE` MUST return code 0422 when the CDC is configured as found, code 0420 when the CDC is unknown, and code 0421 when the RUC of the querying certificate lacks permission to consult that DE.

#### Scenario: CDC found

- GIVEN a `FakeSifenGateway` configured with the `0422` scenario for a CDC
- WHEN `consultarDE` is called with that CDC
- THEN it MUST resolve with `dCodRes` equal to `"0422"`

#### Scenario: CDC not found

- GIVEN a `FakeSifenGateway` with no scenario configured for a CDC
- WHEN `consultarDE` is called with that CDC
- THEN it MUST resolve with `dCodRes` equal to `"0420"`

#### Scenario: RUC not permitted to consult the DE

- GIVEN a `FakeSifenGateway` configured with the `0421` scenario for a CDC
- WHEN `consultarDE` is called with that CDC
- THEN it MUST resolve with `dCodRes` equal to `"0421"`

### Requirement: enviarDESincronico scenario

`FakeSifenGateway.enviarDESincronico` MUST return code 0260 by default for a successful synchronous authorization.

#### Scenario: Synchronous DE authorized

- GIVEN a `FakeSifenGateway` with no scenario configured for `enviarDESincronico`
- WHEN `enviarDESincronico` is called with a single DE
- THEN it MUST resolve with `dCodRes` equal to `"0260"`

### Requirement: enviarEventos batch limit

`FakeSifenGateway.enviarEventos` MUST reject a call carrying more than 15 events.

#### Scenario: More than 15 events

- GIVEN a `FakeSifenGateway`
- WHEN `enviarEventos` is called with 16 events
- THEN it MUST reject the call
- AND MUST NOT record the call as a successful scenario response

### Requirement: Typed timeout errors

Each operation MUST support a configured timeout scenario that rejects the returned promise with a `SifenTimeoutError` without any real waiting.

#### Scenario: Configured timeout

- GIVEN a `FakeSifenGateway` configured with the timeout scenario for `consultarRUC`
- WHEN `consultarRUC` is called
- THEN the call MUST reject with an instance of `SifenTimeoutError`
- AND the call MUST resolve or reject within the same event-loop tick, with no timers used

### Requirement: Call recording

`FakeSifenGateway` MUST record every call made to it, including the operation name and the arguments passed, so tests can assert on gateway usage.

#### Scenario: Recorded call arguments

- GIVEN a `FakeSifenGateway`
- WHEN `enviarLote` is called with a specific batch argument
- THEN the fake's call log MUST contain an entry for `enviarLote`
- AND that entry MUST include the exact argument passed
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
