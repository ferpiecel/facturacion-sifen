/** Placeholder written in place of every sensitive value. */
export const REDACTED = '[REDACTED]';

/** Placeholder for a reference cycle. */
const CIRCULAR = '[Circular]';

/** Placeholder for binary payloads (Buffer, typed arrays, ArrayBuffer). */
const BINARY = '[Binary]';

/**
 * Key fragments whose values never reach the audit log (RNF-08). A key is
 * lower-cased and stripped of `_`/`-`, then redacted when it CONTAINS any
 * fragment, so `accessToken`, `refresh_token`, `certificatePassword` and
 * `p12Base64` are all masked.
 */
export const DEFAULT_SENSITIVE_KEYS: readonly string[] = [
  'secret',
  'token',
  'password',
  'passwd',
  'pwd',
  'apikey',
  'authorization',
  'cookie',
  'privatekey',
  'p12',
  'pfx',
  'certificate',
  'csc',
  'idcsc',
  'hash',
  'signature',
];

/** String values shaped like a secret are masked whatever their key. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk_(?:live|test)_\w+/,
  /-----BEGIN [A-Z ]+-----/,
];

const normalize = (key: string): string => key.toLowerCase().replaceAll(/[_-]/g, '');

/**
 * Returns a deep, JSON-safe copy of `value` with every sensitive key's value
 * (and every secret-shaped string) replaced by {@link REDACTED}. Pure: never
 * mutates its input.
 */
export function redact(
  value: unknown,
  sensitiveKeys: readonly string[] = DEFAULT_SENSITIVE_KEYS,
): unknown {
  const fragments = sensitiveKeys.map(normalize);
  const isSensitiveKey = (key: string): boolean => {
    const normalized = normalize(key);
    return fragments.some((fragment) => normalized.includes(fragment));
  };
  const ancestors = new WeakSet();

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(node)) ? REDACTED : node;
    }
    if (typeof node === 'bigint') {
      return node.toString();
    }
    if (node === null || typeof node !== 'object') {
      return node;
    }
    if (node instanceof Date) {
      return node.toISOString();
    }
    if (ArrayBuffer.isView(node) || node instanceof ArrayBuffer) {
      return BINARY;
    }
    if (ancestors.has(node)) {
      return CIRCULAR;
    }
    ancestors.add(node);
    try {
      if (Array.isArray(node)) {
        return node.map(walk);
      }
      if (node instanceof Set) {
        return [...(node as Set<unknown>)].map(walk);
      }
      const entries: [unknown, unknown][] =
        node instanceof Map ? [...(node as Map<unknown, unknown>)] : Object.entries(node);
      return Object.fromEntries(
        entries.map(([key, child]) => {
          const name = String(key);
          return [name, isSensitiveKey(name) ? REDACTED : walk(child)];
        }),
      );
    } finally {
      ancestors.delete(node);
    }
  };
  return walk(value);
}
