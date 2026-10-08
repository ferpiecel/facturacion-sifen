// Root `prepare`: points git at the versioned hooks. No-op in CI and outside a git checkout.
import { execFileSync } from 'node:child_process';

if (!process.env.CI) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
  } catch {
    // not a git checkout (or git missing): nothing to configure
  }
}
