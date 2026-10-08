// `pnpm verify`: runs the CI quality gates locally on the packages affected versus origin/main.
// Full output goes to .verify.log; stdout gets a one-line summary (or only the failing lines).
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { parsePackages, summarize } from './verify-summary.mjs';

// Mirrors the quality-gates matrix in .github/workflows/ci.yml. db-postgres and worker-redis need Docker/Redis: CI only.
// `test` is omitted on purpose: every package with tests also defines `coverage`
// (`vitest run --coverage`), which runs the same suite once. Add `test` back
// only for a package that has tests but no `coverage` task.
const TASKS = [
  '//#format:check',
  'lint',
  'typecheck',
  'depcruise',
  'build',
  'verify-vendor',
  'coverage',
];
const BASE = process.env.VERIFY_BASE ?? 'origin/main';
const LOG_FILE = '.verify.log';

const started = Date.now();
const result = spawnSync(
  'pnpm',
  ['exec', 'turbo', 'run', ...TASKS, '--affected', '--continue', '--output-logs=errors-only'],
  {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, TURBO_SCM_BASE: BASE, NO_COLOR: '1', FORCE_COLOR: '0' },
  },
);
const log = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`;
writeFileSync(LOG_FILE, log);

const exitCode = result.status ?? 1;
console.log(
  summarize({ log, exitCode, durationMs: Date.now() - started, packages: parsePackages(log) }),
);
process.exit(exitCode === 0 ? 0 : 1);
