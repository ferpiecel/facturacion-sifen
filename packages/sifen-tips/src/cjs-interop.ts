/**
 * The TIPS libraries are CJS. Under `nodenext`, a default import types (and,
 * in real Node, behaves) as the whole CJS module (`{ default: Api }`), but
 * Vitest's Vite-based test runtime auto-unwraps the default export already
 * (`mod` is `Api` directly). Reading whichever shape is present keeps
 * production and tests consistent without depending on either interop rule.
 */
export function resolveCjsDefault(mod: unknown): unknown {
  return (mod as { default?: unknown }).default ?? mod;
}
