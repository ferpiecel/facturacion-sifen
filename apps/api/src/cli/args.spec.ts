import { describe, expect, it } from 'vitest';
import { getOpsDatabaseUrl, OpsArgError, parseOpsArgs } from './args.js';

describe('parseOpsArgs (HU-E1-05)', () => {
  it('parses partner:create', () => {
    expect(parseOpsArgs(['partner:create', '--name', 'Acme'])).toEqual({
      kind: 'partner:create',
      name: 'Acme',
    });
  });

  it('parses tenant:create without --partner', () => {
    expect(parseOpsArgs(['tenant:create', '--name', 'Direct'])).toEqual({
      kind: 'tenant:create',
      name: 'Direct',
      partnerId: undefined,
    });
  });

  it('parses tenant:create with --partner', () => {
    expect(parseOpsArgs(['tenant:create', '--name', 'Partnered', '--partner', 'p-1'])).toEqual({
      kind: 'tenant:create',
      name: 'Partnered',
      partnerId: 'p-1',
    });
  });

  it('parses apikey:create with comma-separated scopes and an optional label', () => {
    expect(
      parseOpsArgs([
        'apikey:create',
        '--tenant',
        't-1',
        '--env',
        'live',
        '--scopes',
        'documents:write,documents:read',
        '--label',
        'CI key',
      ]),
    ).toEqual({
      kind: 'apikey:create',
      tenantId: 't-1',
      environment: 'live',
      scopes: ['documents:write', 'documents:read'],
      label: 'CI key',
    });
  });

  it('rejects apikey:create with an environment other than live/test', () => {
    expect(() =>
      parseOpsArgs(['apikey:create', '--tenant', 't-1', '--env', 'staging', '--scopes', 'x']),
    ).toThrow(OpsArgError);
  });

  it('rejects apikey:create missing --tenant', () => {
    expect(() => parseOpsArgs(['apikey:create', '--env', 'live', '--scopes', 'x'])).toThrow(
      OpsArgError,
    );
  });

  it('parses apikey:revoke', () => {
    expect(parseOpsArgs(['apikey:revoke', '--key-id', 'abc123'])).toEqual({
      kind: 'apikey:revoke',
      keyId: 'abc123',
    });
  });

  it('rejects an unknown subcommand', () => {
    expect(() => parseOpsArgs(['nope'])).toThrow(OpsArgError);
  });

  it('rejects no subcommand at all', () => {
    expect(() => parseOpsArgs([])).toThrow(OpsArgError);
  });
});

describe('getOpsDatabaseUrl (HU-E1-05)', () => {
  it('returns OPS_DATABASE_URL when set', () => {
    expect(getOpsDatabaseUrl({ OPS_DATABASE_URL: 'postgres://owner@host/db' })).toBe(
      'postgres://owner@host/db',
    );
  });

  it('throws when OPS_DATABASE_URL is unset, even if DATABASE_URL is', () => {
    expect(() =>
      getOpsDatabaseUrl({ DATABASE_URL: 'postgres://app_login@host/db' }),
    ).toThrow(OpsArgError);
  });
});
