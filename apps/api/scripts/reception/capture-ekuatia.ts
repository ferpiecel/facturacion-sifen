/**
 * HUMAN-RUN ONLY. Makes ONE real consultation against eKuatia and spends ONE paid captcha
 * solve. Never run by agents or CI. See README.md in this folder.
 *
 *   TWOCAPTCHA_API_KEY=... pnpm --filter @sifen/api capture:ekuatia -- --i-am-a-human --cdc <44 digits>
 *   pnpm --filter @sifen/api capture:ekuatia -- --i-am-a-human --probe-rejected-captcha --cdc <44 digits>  (spends nothing)
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CaptchaSolveError,
  type CaptchaSolver,
} from '../../src/modules/reception/application/ports/captcha-solver.port.js';
import { TwoCaptchaSolver } from '../../src/modules/reception/infrastructure/adapters/two-captcha-solver.adapter.js';
import {
  CAPTURE_HOSTS,
  checkGuards,
  parseCaptureArgs,
  isInsideVersionedTree,
  runCapture,
  versionLabel,
  type CaptureArgs,
} from './capture-core.js';

export interface MainDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly print: (line: string) => void;
  readonly confirm: (question: string) => Promise<boolean>;
  readonly fetch: typeof fetch;
  readonly createSolver: (apiKey: string) => CaptchaSolver;
  /** Root of the versioned tree (the directory holding `.git`), when known. */
  readonly repoRoot?: string;
  readonly isNonEmptyDir: (path: string) => boolean;
  /** Creates the directory and proves it is writable; throws otherwise. */
  readonly prepareDir: (path: string) => void;
  readonly writeFile: (path: string, content: string) => void;
  readonly now: () => Date;
}

/** Returns the process exit code. Every refusal happens before any network access. */
export async function main(argv: readonly string[], deps: MainDeps): Promise<number> {
  let args: CaptureArgs;
  try {
    args = parseCaptureArgs(argv);
  } catch (error) {
    deps.print(error instanceof Error ? error.message : 'Invalid arguments.');
    return 2;
  }
  const guard = checkGuards(args, { CI: deps.env.CI });
  if (!guard.ok || args.cdc === undefined) {
    deps.print(guard.ok ? 'Missing CDC.' : guard.reason);
    return 2;
  }
  const probe = args.probeRejectedCaptcha;
  // The key is read only now, after every other guard passed (and never in probe mode).
  const apiKey = probe ? undefined : deps.env.TWOCAPTCHA_API_KEY;
  if (!probe && (apiKey === undefined || apiKey.trim() === '')) {
    deps.print('Missing TWOCAPTCHA_API_KEY in the environment (it is never read from .env).');
    return 2;
  }
  // The destination is fixed and proven writable BEFORE any spend, so a write failure cannot
  // waste a solved captcha. The label is already restricted; the resolved path is checked anyway.
  const startedAt = deps.now();
  const dir = `${args.out}/${versionLabel(startedAt)}/${args.label}`;
  if (!resolve(dir).startsWith(resolve(args.out) + sep)) {
    deps.print('Refusing to write outside the output directory.');
    return 2;
  }
  if (deps.repoRoot !== undefined && isInsideVersionedTree(resolve(args.out), deps.repoRoot)) {
    deps.print(
      'Refusing --out inside the versioned tree: use .captures/ or a path outside the repository.',
    );
    return 2;
  }
  if (deps.isNonEmptyDir(dir)) {
    deps.print(`${dir} already has files: choose another --label (nothing is overwritten).`);
    return 2;
  }
  try {
    deps.prepareDir(dir);
  } catch {
    deps.print(`The output directory ${dir} is not writable. Nothing was requested.`);
    return 2;
  }
  if (probe) {
    deps.print('PROBE: sends one POST to ekuatia.set.gov.py with an invalid captcha token.');
    deps.print('This does not spend 2Captcha credit and never contacts 2captcha.com.');
  } else {
    deps.print(
      `About to call: ${CAPTURE_HOSTS.join(', ')} (one POST + up to two GETs, one captcha solve).`,
    );
    deps.print('Solving a captcha costs money (a few cents). Do not loop this script.');
  }
  if (!args.yes && !(await deps.confirm('Proceed? [y/N] '))) {
    deps.print('Aborted by the user. Nothing was requested.');
    return 1;
  }
  const result = await runCapture({
    cdc: args.cdc,
    fetch: deps.fetch,
    ...(apiKey === undefined ? {} : { solver: deps.createSolver(apiKey), apiKey }),
    probeRejectedCaptcha: probe,
    skipCookieControl: args.skipCookieControl,
    label: args.label,
    now: () => startedAt,
  }).catch((error: unknown) => {
    // Only our stable code: provider text could echo the key.
    deps.print(
      `Capture failed: ${error instanceof CaptchaSolveError ? error.code : 'unexpected_error'}`,
    );
    return undefined;
  });
  if (result === undefined) return 1;
  try {
    deps.writeFile(`${dir}/requests.json`, JSON.stringify(result.records, null, 2));
    deps.writeFile(`${dir}/meta.json`, JSON.stringify(result.meta, null, 2));
    if (result.documentXml !== undefined)
      deps.writeFile(`${dir}/documento.xml`, result.documentXml);
  } catch {
    // The error text is not printed: it could carry paths or secrets.
    deps.print(
      `Writing the capture to ${dir} failed. The result exists only in memory of this process and is lost on exit.`,
    );
    deps.print(
      `Statuses: ${result.records.map((r) => String(r.status_code ?? r.error)).join(', ')}`,
    );
    return 1;
  }
  deps.print(`Statuses: ${result.records.map((r) => String(r.status_code ?? r.error)).join(', ')}`);
  if (result.records.every((r) => r.status_code === undefined)) {
    deps.print(
      `WARNING: no response was received from eKuatia (network failure after the captcha was solved). The files in ${dir} record the failed attempt.`,
    );
  }
  deps.print(
    `Raw capture written to ${dir} (gitignored, NOT anonymized). Run anonymize-fixtures next.`,
  );
  return result.records.every((r) => r.status_code === undefined) ? 1 : 0;
}

/** Walks up from this module to the directory holding `.git` (a folder, or a file in a worktree). */
function findRepoRoot(start: string): string | undefined {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(resolve(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

if (process.argv.length > 1 && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), {
    env: process.env,
    print: (line) => {
      console.log(line);
    },
    confirm: askYesNo,
    fetch,
    createSolver: (apiKey) => new TwoCaptchaSolver({ apiKey }),
    repoRoot: findRepoRoot(dirname(fileURLToPath(import.meta.url))),
    isNonEmptyDir: (path) => existsSync(path) && readdirSync(path).length > 0,
    prepareDir: (path) => {
      mkdirSync(path, { recursive: true });
      const probe = `${path}/.write-check`;
      writeFileSync(probe, '');
      rmSync(probe);
    },
    writeFile: (path, content) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, { mode: 0o600 });
    },
    now: () => new Date(),
  });
}
