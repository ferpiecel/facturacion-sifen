# SIFEN XSD Validation Specification

## Purpose

Provide a deterministic, offline API and vendored schema set to validate SIFEN XML documents against the official DNIT XSD graph, with integrity verification and a controlled refresh workflow.

## Requirements

### Requirement: Offline XML validation API

The `packages/sifen-xsd` package MUST export `validateXml(xml: string, schema: SifenSchema): { valid: boolean; errors: XsdError[] }`, resolving all `xsd:include`/`xsd:import` references exclusively from the vendored schema directory, without network access.

#### Scenario: Official signed example validates successfully

- GIVEN the official example `docs/referencia/ejemplos/ejemplo-de-firmado-v150.xml`
- WHEN `validateXml` is called with schema `siRecepDE`
- THEN the result MUST have `valid: true`
- AND `errors` MUST be an empty array

#### Scenario: Missing required element is rejected

- GIVEN an XML document that omits a required element defined by the `siRecepDE` schema
- WHEN `validateXml` is called with schema `siRecepDE`
- THEN the result MUST have `valid: false`
- AND `errors` MUST contain at least one entry naming the missing element

#### Scenario: Wrong enum value is rejected

- GIVEN an XML document with a field value outside its schema-defined enumeration
- WHEN `validateXml` is called with the corresponding schema
- THEN the result MUST have `valid: false`
- AND `errors` MUST contain at least one entry identifying the invalid field

#### Scenario: Validation runs without network access

- GIVEN no network connectivity is available
- WHEN `validateXml` is called with any vendored schema
- THEN validation MUST complete and return a result
- AND no outbound network call MUST be attempted

### Requirement: Vendored schema integrity

The package MUST vendor the official v150 XSD graph (plus referenced v141 files and `xmldsig-core-schema`) under `packages/sifen-xsd/vendor/`, and MUST record a sha256 checksum for every vendored file in `checksums.json`.

#### Scenario: Vendored files match recorded checksums

- GIVEN the vendored XSD files under `packages/sifen-xsd/vendor/`
- WHEN the checksum verification step runs
- THEN every file's computed sha256 MUST match its entry in `checksums.json`
- AND the step MUST exit successfully

#### Scenario: Tampered vendored file fails verification

- GIVEN a vendored XSD file has been modified after checksums were recorded
- WHEN the checksum verification step runs
- THEN it MUST exit with a non-zero status
- AND it MUST report which file's checksum does not match

### Requirement: Controlled refresh workflow

The package MUST provide a refresh script that downloads the schema graph from DNIT, follows redirects, verifies each downloaded file's sha256, and aborts without modifying vendored files if any checksum does not match the expected value, unless run in explicit update mode.

#### Scenario: Refresh aborts on checksum drift

- GIVEN the refresh script is run without explicit update mode
- WHEN a downloaded file's sha256 does not match the expected checksum
- THEN the script MUST abort with a non-zero exit status
- AND it MUST NOT overwrite any file under `packages/sifen-xsd/vendor/`

#### Scenario: Explicit update mode records new checksums

- GIVEN the refresh script is run with explicit update mode
- WHEN downloads complete successfully
- THEN the script MUST overwrite the vendored files
- AND it MUST regenerate `checksums.json` with the new sha256 values
