import { describe, expect, it, vi } from 'vitest';
import { AuthenticateApiKeyUseCase } from './authenticate-api-key.use-case.js';
import type { ApiKeyLookup, ResolvedApiKeyRecord } from './ports/api-key-lookup.port.js';
import type { SecretVerifier } from './ports/secret-verifier.port.js';

const KEY_ID = 'a'.repeat(24);
const SECRET = 'b'.repeat(32);
const RAW_KEY = `sk_live_${KEY_ID}_${SECRET}`;

const RECORD: ResolvedApiKeyRecord = {
  id: 'record-id',
  tenantId: 'tenant-id',
  secretHash: 'real-hash',
  scopes: ['documents:write'],
  environment: 'live',
};

function makeLookup(record: ResolvedApiKeyRecord | null) {
  const resolveByKeyId = vi.fn<ApiKeyLookup['resolveByKeyId']>().mockResolvedValue(record);
  const touchLastUsed = vi.fn<ApiKeyLookup['touchLastUsed']>().mockResolvedValue(undefined);
  const lookup: ApiKeyLookup = { resolveByKeyId, touchLastUsed };
  return { lookup, resolveByKeyId, touchLastUsed };
}

function makeVerifier(result: boolean) {
  const verify = vi.fn<SecretVerifier['verify']>().mockResolvedValue(result);
  const verifier: SecretVerifier = { verify };
  return { verifier, verify };
}

describe('AuthenticateApiKeyUseCase', () => {
  it('returns tenant id, scopes and environment for a valid key', async () => {
    const { lookup, resolveByKeyId, touchLastUsed } = makeLookup(RECORD);
    const { verifier, verify } = makeVerifier(true);
    const useCase = new AuthenticateApiKeyUseCase(lookup, verifier);

    const result = await useCase.execute(RAW_KEY);

    expect(result).toEqual({
      tenantId: 'tenant-id',
      scopes: ['documents:write'],
      environment: 'live',
    });
    expect(resolveByKeyId).toHaveBeenCalledWith(KEY_ID);
    expect(verify).toHaveBeenCalledWith(SECRET, 'real-hash');
    expect(touchLastUsed).toHaveBeenCalledWith('record-id');
  });

  it('returns null for a malformed key, without ever calling the lookup', async () => {
    const { lookup, resolveByKeyId } = makeLookup(RECORD);
    const { verifier } = makeVerifier(true);
    const useCase = new AuthenticateApiKeyUseCase(lookup, verifier);

    const result = await useCase.execute('not-a-key');

    expect(result).toBeNull();
    expect(resolveByKeyId).not.toHaveBeenCalled();
  });

  it('runs a dummy verification for an unknown key id (no timing oracle)', async () => {
    const { lookup, touchLastUsed } = makeLookup(null);
    const { verifier, verify } = makeVerifier(false);
    const useCase = new AuthenticateApiKeyUseCase(lookup, verifier);

    const result = await useCase.execute(RAW_KEY);

    expect(result).toBeNull();
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith(SECRET, expect.any(String));
    expect(touchLastUsed).not.toHaveBeenCalled();
  });

  it('returns null for a known key id with a wrong secret', async () => {
    const { lookup, touchLastUsed } = makeLookup(RECORD);
    const { verifier } = makeVerifier(false);
    const useCase = new AuthenticateApiKeyUseCase(lookup, verifier);

    const result = await useCase.execute(RAW_KEY);

    expect(result).toBeNull();
    expect(touchLastUsed).not.toHaveBeenCalled();
  });

  it('returns null when the key prefix environment does not match the resolved record', async () => {
    const { lookup, touchLastUsed } = makeLookup({ ...RECORD, environment: 'test' });
    const { verifier } = makeVerifier(true);
    const useCase = new AuthenticateApiKeyUseCase(lookup, verifier);

    const result = await useCase.execute(RAW_KEY);

    expect(result).toBeNull();
    expect(touchLastUsed).not.toHaveBeenCalled();
  });

  it('never fails authentication when touchLastUsed rejects', async () => {
    const { lookup, touchLastUsed } = makeLookup(RECORD);
    touchLastUsed.mockRejectedValue(new Error('db down'));
    const { verifier } = makeVerifier(true);
    const useCase = new AuthenticateApiKeyUseCase(lookup, verifier);

    const result = await useCase.execute(RAW_KEY);

    expect(result).toEqual({
      tenantId: 'tenant-id',
      scopes: ['documents:write'],
      environment: 'live',
    });
  });
});
