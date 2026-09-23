# Delta for CI Pipeline

## ADDED Requirements

### Requirement: Vendored XSD checksum verification gate

CI MUST run an offline checksum verification step for the `packages/sifen-xsd` vendored schema graph, comparing every file under `packages/sifen-xsd/vendor/` against `checksums.json`, and MUST fail the workflow if any file does not match.

#### Scenario: Vendored XSDs match checksums

- GIVEN a commit where every file under `packages/sifen-xsd/vendor/` matches its recorded sha256 in `checksums.json`
- WHEN CI runs
- THEN the checksum verification step MUST report success

#### Scenario: A tampered vendored XSD fails CI

- GIVEN a commit modifies a file under `packages/sifen-xsd/vendor/` without updating `checksums.json`
- WHEN CI runs
- THEN the checksum verification step MUST exit non-zero
- AND the overall workflow run MUST be marked failed
