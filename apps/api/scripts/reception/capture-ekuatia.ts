/**
 * HUMAN-RUN ONLY. Makes ONE real consultation against eKuatia and spends ONE paid captcha
 * solve. Never run by agents or CI. See README.md in this folder.
 *
 *   TWOCAPTCHA_API_KEY=... pnpm --filter @sifen/api capture:ekuatia -- --i-am-a-human --cdc <44 digits>
 *   pnpm --filter @sifen/api capture:ekuatia -- --i-am-a-human --probe-rejected-captcha --cdc <44 digits>  (spends nothing)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import {
  CaptchaSolveError,
  type CaptchaSolver,
} from '../../src/modules/reception/application/ports/captcha-solver.port.js';
import { TwoCaptchaSolver } from '../../src/modules/reception/infrastructure/adapters/two-captcha-solver.adapter.js';
import {
  CAPTURE_HOSTS,
  checkGuards,
  parseCaptureArgs,
  runCapture,
  type CaptureArgs,
} from './capture-core.js';

export interface MainDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly print: (line: string) => void;
  readonly confirm: (question: string) => Promise<boolean>;
  readonly fetch: typeof fetch;
  readonly createSolver: (apiKey: string) => CaptchaSolver;
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
    now: deps.now,
  }).catch((error: unknown) => {
    // Only our stable code: provider text could echo the key.
    deps.print(
      `Capture failed: ${error instanceof CaptchaSolveError ? error.code : 'unexpected_error'}`,
    );
    return undefined;
  });
  if (result === undefined) return 1;
  const dir = `${args.out}/${String(result.meta.version)}/${args.label}`;
  deps.writeFile(`${dir}/requests.json`, JSON.stringify(result.records, null, 2));
  deps.writeFile(`${dir}/meta.json`, JSON.stringify(result.meta, null, 2));
  if (result.documentXml !== undefined) deps.writeFile(`${dir}/documento.xml`, result.documentXml);
  deps.print(`Statuses: ${result.records.map((r) => String(r.status_code ?? r.error)).join(', ')}`);
  deps.print(
    `Raw capture written to ${dir} (gitignored, NOT anonymized). Run anonymize-fixtures next.`,
  );
  return 0;
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
    writeFile: (path, content) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, { mode: 0o600 });
    },
    now: () => new Date(),
  });
}
