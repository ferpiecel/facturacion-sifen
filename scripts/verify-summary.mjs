// Pure helpers that turn turbo's full output into the short summary `pnpm verify` prints.
export const MAX_FAILURE_LINES = 40;

// Lines that never help to diagnose a failure.
const NOISE = [/^\S+: \$ /, /\[ELIFECYCLE\]/, /: cache (miss|hit)/, /^\S+:\s*$/];

// eslint-disable-next-line no-control-regex
const stripAnsi = (text) => text.replace(/\u001b\[[0-9;]*m/g, '');

export function parseFailedTasks(log) {
  const line = stripAnsi(log)
    .split('\n')
    .find((l) => l.startsWith('Failed:'));
  if (!line) return [];
  return line
    .slice('Failed:'.length)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

export function parsePackages(log) {
  const match = stripAnsi(log).match(/Packages in scope: (.+)/);
  return match ? match[1].split(',').map((p) => p.trim()) : [];
}

export function formatDuration(ms) {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

// turbo prefixes each task line with "<package>:<script>: " ("@sifen/api#lint" -> "@sifen/api:lint: ").
const logPrefix = (taskId) => `${taskId.replace('#', ':')}: `;

function failureLines(log, failedTasks) {
  const lines = stripAnsi(log).split('\n');
  if (failedTasks.length === 0) return lines.filter((l) => l.trim()).slice(-MAX_FAILURE_LINES);
  const prefixes = failedTasks.map(logPrefix);
  return lines.filter(
    (l) => prefixes.some((p) => l.startsWith(p)) && !NOISE.some((n) => n.test(l)),
  );
}

export function summarize({ log, exitCode, durationMs, packages }) {
  if (exitCode === 0) return `verify OK (${packages.join(', ')}) ${formatDuration(durationMs)}`;
  const failed = parseFailedTasks(log);
  const lines = failureLines(log, failed);
  const shown = lines.slice(0, MAX_FAILURE_LINES);
  const out = [`verify FAIL ${failed.length ? failed.join(', ') : 'turbo'}`, ...shown];
  if (lines.length > shown.length)
    out.push(`... ${lines.length - shown.length} more lines in .verify.log`);
  return out.join('\n');
}
