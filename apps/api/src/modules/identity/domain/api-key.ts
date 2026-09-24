export type ApiKeyEnvironment = 'live' | 'test';

export interface ParsedApiKey {
  environment: ApiKeyEnvironment;
  keyId: string;
  secret: string;
}

/**
 * `sk_<live|test>_<keyId>_<secret>`: `keyId` mirrors the
 * `api_keys_key_id_format` CHECK constraint (24-64 alphanumerics), `secret`
 * is base62 (alphanumeric) and at least 32 chars.
 */
const API_KEY_PATTERN = /^sk_(live|test)_([A-Za-z0-9]{24,64})_([A-Za-z0-9]{32,})$/;

/** Parses a raw `Authorization` bearer token into its three parts, or `null` if malformed. */
export function parseApiKey(rawKey: string): ParsedApiKey | null {
  const match = API_KEY_PATTERN.exec(rawKey);
  if (!match) {
    return null;
  }

  const [, environment, keyId, secret] = match;
  return { environment: environment as ApiKeyEnvironment, keyId, secret };
}
