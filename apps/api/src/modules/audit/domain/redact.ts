/** Placeholder written in place of every sensitive value. */
export const REDACTED = '[REDACTED]';

/**
 * Keys whose values never reach the audit log (RNF-08). Compared after
 * lower-casing and stripping `_`/`-`, so `secret_hash`, `secretHash` and
 * `SECRET-HASH` all match.
 */
export const DEFAULT_SENSITIVE_KEYS: readonly string[] = [
  'secrethash',
  'csc',
  'certificate',
  'p12',
  'password',
  'token',
  'apikeysecret',
];

const normalize = (key: string): string => key.toLowerCase().replaceAll(/[_-]/g, '');

/**
 * Returns a deep, JSON-safe copy of `value` with every sensitive key's value
 * replaced by {@link REDACTED}. Pure: never mutates its input.
 */
export function redact(
  value: unknown,
  sensitiveKeys: readonly string[] = DEFAULT_SENSITIVE_KEYS,
): unknown {
  const sensitive = new Set(sensitiveKeys.map(normalize));
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (node instanceof Date) {
      return node.toISOString();
    }
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node).map(([key, child]) => [
          key,
          sensitive.has(normalize(key)) ? REDACTED : walk(child),
        ]),
      );
    }
    return node;
  };
  return walk(value);
}
