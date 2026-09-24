## ADDED Requirements

### Requirement: Test coverage gate

CI MUST run a `coverage` task, using Vitest's v8 coverage provider, for every package that defines tests, and MUST fail the workflow if lines, branches, functions, or statements coverage on that package's non-excluded source falls below 85%.

#### Scenario: Coverage above threshold passes CI

- GIVEN a commit where every tested package's lines/branches/functions/statements coverage is at or above 85%
- WHEN CI runs the `coverage` task
- THEN every package's coverage task MUST report success
- AND the overall workflow run MUST be green

#### Scenario: A coverage regression fails CI

- GIVEN a commit drops a package's line, branch, function, or statement coverage below 85%
- WHEN CI runs the `coverage` task
- THEN the coverage task for that package MUST exit non-zero with a threshold-violation message
- AND the overall workflow run MUST be marked failed

#### Scenario: Exclusions are narrow and justified

- GIVEN a package's coverage configuration excludes a file or directory from the gate
- WHEN the exclusion is reviewed
- THEN it MUST be limited to bootstrap entrypoints, CLI scripts, test fixtures/support files, or type-only declaration output
- AND MUST NOT exclude domain or application logic
