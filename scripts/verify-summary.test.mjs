import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_FAILURE_LINES,
  formatDuration,
  parseFailedTasks,
  summarize,
} from './verify-summary.mjs';

const FAILED_LOG = [
  '@sifen/api:typecheck: $ tsc --noEmit',
  "@sifen/api:typecheck: src/main.ts(19,1): error TS2304: Cannot find name 'x'.",
  '@sifen/api:typecheck: [ELIFECYCLE] Command failed with exit code 2.',
  '//:format:check: $ prettier --check .',
  '//:format:check: [warn] bad.ts',
  '//:format:check: ',
  '@sifen/api#typecheck:  ERROR  command exited (2)',
  ' Tasks:    4 successful, 6 total',
  'Failed:    //#format:check, @sifen/api#typecheck',
  ' ERROR  run failed: command  exited (2)',
].join('\n');

test('parseFailedTasks reads the turbo "Failed:" line', () => {
  assert.deepEqual(parseFailedTasks(FAILED_LOG), ['//#format:check', '@sifen/api#typecheck']);
  assert.deepEqual(parseFailedTasks('all good'), []);
});

test('parseFailedTasks ignores ANSI colors', () => {
  assert.deepEqual(parseFailedTasks('\u001b[31mFailed:\u001b[0m    @sifen/api#lint'), [
    '@sifen/api#lint',
  ]);
});

test('formatDuration prints seconds under a minute and m s above', () => {
  assert.equal(formatDuration(4200), '4.2s');
  assert.equal(formatDuration(75_000), '1m15s');
});

test('summarize success is exactly one line', () => {
  const out = summarize({ log: '', exitCode: 0, durationMs: 4200, packages: ['@sifen/api', '//'] });
  assert.equal(out, 'verify OK (@sifen/api, //) 4.2s');
});

test('summarize failure names the tasks and keeps only failing lines, no noise', () => {
  const out = summarize({ log: FAILED_LOG, exitCode: 2, durationMs: 1000, packages: [] }).split(
    '\n',
  );
  assert.equal(out[0], 'verify FAIL //#format:check, @sifen/api#typecheck');
  assert.deepEqual(out.slice(1), [
    "@sifen/api:typecheck: src/main.ts(19,1): error TS2304: Cannot find name 'x'.",
    '//:format:check: [warn] bad.ts',
  ]);
});

test('summarize caps the failure body and points to the log', () => {
  const noisy = Array.from({ length: 100 }, (_, i) => `@sifen/api:test: FAIL case ${i}`);
  const log = [...noisy, 'Failed:    @sifen/api#test'].join('\n');
  const out = summarize({ log, exitCode: 1, durationMs: 1, packages: [] }).split('\n');
  assert.equal(out.length, 1 + MAX_FAILURE_LINES + 1);
  assert.match(out.at(-1), /^\.\.\. 60 more lines in \.verify\.log$/);
});

test('summarize falls back to the log tail when turbo reports no failed task', () => {
  const out = summarize({
    log: 'boom\nbad things',
    exitCode: 1,
    durationMs: 1,
    packages: [],
  }).split('\n');
  assert.equal(out[0], 'verify FAIL turbo');
  assert.deepEqual(out.slice(1), ['boom', 'bad things']);
});
