import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getGuardCallCount,
  installNoSubprocessGuard,
  restoreNoSubprocessGuard,
} from './no-subprocess-guard.ts';

const GUARDED_METHODS = [
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
] as const;

describe('no-subprocess guard', () => {
  afterEach(() => {
    restoreNoSubprocessGuard();
  });

  it('traps every documented entry point xmlsign could use and counts each call (tripwire)', async () => {
    installNoSubprocessGuard();
    expect(getGuardCallCount()).toBe(0);

    const cp = await import('node:child_process');
    for (const method of GUARDED_METHODS) {
      const call = cp[method] as (...args: unknown[]) => unknown;
      expect(() => call('true')).toThrow(/no-subprocess guard/);
    }

    expect(getGuardCallCount()).toBe(GUARDED_METHODS.length);
  });

  it('restores the original implementation so real calls work again', () => {
    installNoSubprocessGuard();
    restoreNoSubprocessGuard();

    expect(() => spawn('true')).not.toThrow();
  });
});
