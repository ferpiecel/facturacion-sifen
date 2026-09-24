import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getGuardCallCount,
  installNoSubprocessGuard,
  restoreNoSubprocessGuard,
} from './no-subprocess-guard.ts';

describe('no-subprocess guard', () => {
  afterEach(() => {
    restoreNoSubprocessGuard();
  });

  it('throws when a guarded child_process method is called (tripwire)', async () => {
    installNoSubprocessGuard();

    const { spawn: guardedSpawn } = await import('node:child_process');

    expect(() => guardedSpawn('true')).toThrow(/no-subprocess guard/);
  });

  it('traps every documented entry point xmlsign could use', async () => {
    installNoSubprocessGuard();

    const cp = await import('node:child_process');

    expect(() => cp.spawn('true')).toThrow(/no-subprocess guard/);
    expect(() => cp.spawnSync('true')).toThrow(/no-subprocess guard/);
    expect(() => cp.exec('true')).toThrow(/no-subprocess guard/);
    expect(() => cp.execSync('true')).toThrow(/no-subprocess guard/);
    expect(() => cp.execFile('true')).toThrow(/no-subprocess guard/);
    expect(() => cp.execFileSync('true')).toThrow(/no-subprocess guard/);
    expect(() => cp.fork('true')).toThrow(/no-subprocess guard/);
  });

  it('restores the original implementation so real calls work again', () => {
    installNoSubprocessGuard();
    restoreNoSubprocessGuard();

    expect(() => spawn('true')).not.toThrow();
  });

  it('records zero calls when nothing guarded is invoked, and counts each trapped call', async () => {
    installNoSubprocessGuard();
    expect(getGuardCallCount()).toBe(0);

    const cp = await import('node:child_process');
    expect(() => cp.spawn('true')).toThrow();
    expect(() => cp.exec('true')).toThrow();

    expect(getGuardCallCount()).toBe(2);
  });
});
