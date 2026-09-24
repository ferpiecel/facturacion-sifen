import { parseApiKey, type ApiKeyEnvironment } from '../domain/api-key.js';
import type { ApiKeyLookup } from './ports/api-key-lookup.port.js';
import type { SecretVerifier } from './ports/secret-verifier.port.js';

export interface AuthenticatedApiKey {
  tenantId: string;
  scopes: string[];
  environment: ApiKeyEnvironment;
}

/**
 * A syntactically valid but never-matching Argon2id hash: used whenever
 * there is no real hash to verify against (unknown key id), so a lookup
 * miss still spends roughly the same time as a lookup hit with a wrong
 * secret. Without this, response latency alone would let a caller tell
 * "unknown key" apart from "wrong secret" (timing oracle).
 *
 * Encoded with exactly {@link ARGON2_PARAMS} (`m=19456,t=2,p=1` below) —
 * a spec asserts that equality, so this constant can never drift silently
 * from the real cost the adapter hashes/verifies with.
 */
export const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/**
 * Authenticates a raw `Authorization` bearer value against a resolved api
 * key. Returns `null` for every failure mode (malformed, unknown, revoked,
 * wrong secret, environment mismatch) so callers cannot distinguish them
 * (backlog HU-E1-04: no oracle).
 */
export class AuthenticateApiKeyUseCase {
  constructor(
    private readonly lookup: ApiKeyLookup,
    private readonly verifier: SecretVerifier,
  ) {}

  async execute(rawKey: string): Promise<AuthenticatedApiKey | null> {
    const parsed = parseApiKey(rawKey);
    if (!parsed) {
      return null;
    }

    const record = await this.lookup.resolveByKeyId(parsed.keyId);
    const hash = record?.secretHash ?? DUMMY_HASH;
    const isSecretValid = await this.verifier.verify(parsed.secret, hash);

    if (!record || !isSecretValid || record.environment !== parsed.environment) {
      return null;
    }

    // Best-effort: the port contract requires implementations to never
    // reject, but this call is defended anyway so a misbehaving adapter
    // can never fail an otherwise-successful authentication.
    await this.lookup.touchLastUsed(record.id).catch(() => undefined);

    return { tenantId: record.tenantId, scopes: record.scopes, environment: record.environment };
  }
}
