import { createRequire, syncBuiltinESMExports } from 'node:module';

/** Every `child_process` entry point a native or JVM-spawning library could use. */
const GUARDED_METHODS = [
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
] as const;

type GuardedMethod = (typeof GUARDED_METHODS)[number];
type ChildProcessModule = typeof import('node:child_process');

let originals: Partial<Record<GuardedMethod, ChildProcessModule[GuardedMethod]>> | null = null;
let callCount = 0;

function throwOnCall(method: GuardedMethod): never {
  callCount += 1;
  throw new Error(
    `no-subprocess guard: child_process.${method} must not be called (ADR-0015 forbids spawning a JVM)`,
  );
}

/** Number of guarded `child_process` calls trapped since the last install. */
export function getGuardCallCount(): number {
  return callCount;
}

/**
 * Stubs every `node:child_process` spawn/exec entry point on the real module
 * object (the same binding `facturacionelectronicapy-xmlsign` would resolve)
 * and resyncs `node:` ESM named exports. Install before a dynamic `import()`
 * of the adapters under test, so TIPS-library-time references are trapped too.
 */
export function installNoSubprocessGuard(): void {
  const require = createRequire(import.meta.url);
  const cp = require('node:child_process') as unknown as Record<GuardedMethod, unknown>;
  const typedCp = cp as unknown as ChildProcessModule;
  originals = {};
  callCount = 0;
  for (const method of GUARDED_METHODS) {
    originals[method] = typedCp[method];
    cp[method] = () => throwOnCall(method);
  }
  syncBuiltinESMExports();
}

/** Restores every guarded `node:child_process` method to its original implementation. */
export function restoreNoSubprocessGuard(): void {
  if (!originals) return;
  const require = createRequire(import.meta.url);
  const cp = require('node:child_process') as unknown as Record<GuardedMethod, unknown>;
  for (const method of GUARDED_METHODS) {
    const original = originals[method];
    if (original) cp[method] = original;
  }
  syncBuiltinESMExports();
  originals = null;
}
