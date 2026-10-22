// PreToolUse hook: refuse git commands that skip the commit/push hooks (pnpm verify).
// Blocks --no-verify on commit/push/merge/rebase/cherry-pick/am, `git commit -n`,
// and `git -c core.hooksPath=...`. Quoted text (commit messages, echo strings) is ignored.
let raw = '';
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  let command = '';
  try {
    command = JSON.parse(raw)?.tool_input?.command ?? '';
  } catch {
    process.exit(0);
  }
  const reason = findSkip(command);
  if (reason) {
    process.stderr.write(
      `Blocked: ${reason} skips pnpm verify. Push normally; on vitest SIGKILL retry with VITEST_MAX_WORKERS=1.\n`,
    );
    process.exit(2);
  }
  process.exit(0);
});

const HOOKED = new Set(['commit', 'push', 'merge', 'rebase', 'cherry-pick', 'am']);

function findSkip(command) {
  const unquoted = command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, ' Q ');
  for (const segment of unquoted.split(/&&|\|\||[;|&\n()]/)) {
    const words = segment.trim().split(/\s+/);
    const git = words.indexOf('git');
    if (git < 0) continue;
    let i = git + 1;
    while (i < words.length && words[i].startsWith('-')) {
      const option = words[i];
      if (option === '-c' && /^core\.hookspath=/i.test(words[i + 1] ?? ''))
        return 'git -c core.hooksPath';
      if (/^-ccore\.hookspath=/i.test(option)) return 'git -c core.hooksPath';
      i += option === '-c' || option === '-C' ? 2 : 1;
    }
    const sub = words[i];
    if (!HOOKED.has(sub)) continue;
    const args = words.slice(i + 1);
    if (args.includes('--no-verify')) return `git ${sub} --no-verify`;
    if (sub === 'commit' && args.some((a) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a)))
      return 'git commit -n';
  }
  return null;
}
