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

describe('parseOpsArgs fiscal:set (HU-E2-01)', () => {
  const baseArgs = [
    'fiscal:set',
    '--tenant',
    't-1',
    '--ruc',
    '4490207-7',
    '--legal-name',
    'Acme SA',
    '--taxpayer-type',
    'juridica',
    '--activity',
    '62010:Programación informática',
  ];

  it('parses a full fiscal:set command', () => {
    const command = parseOpsArgs([
      ...baseArgs,
      '--trade-name',
      'Acme',
      '--regime',
      '1',
      '--activity',
      '62020:Consultoría informática',
    ]);

    expect(command).toEqual({
      kind: 'fiscal:set',
      tenantId: 't-1',
      profile: {
        ruc: { base: '4490207', dv: 7 },
        legalName: 'Acme SA',
        tradeName: 'Acme',
        taxpayerType: 'persona_juridica',
        regimeCode: '1',
        economicActivities: [
          { code: '62010', description: 'Programación informática' },
          { code: '62020', description: 'Consultoría informática' },
        ],
      },
    });
  });

  it('parses fisica taxpayer type without optional flags', () => {
    const command = parseOpsArgs([
      'fiscal:set',
      '--tenant',
      't-1',
      '--ruc',
      '4490207-7',
      '--legal-name',
      'Juan Perez',
      '--taxpayer-type',
      'fisica',
      '--activity',
      '62010:Programación informática',
    ]);

    expect(command.kind).toBe('fiscal:set');
    if (command.kind === 'fiscal:set') {
      expect(command.profile.taxpayerType).toBe('persona_fisica');
      expect(command.profile.tradeName).toBeNull();
      expect(command.profile.regimeCode).toBeNull();
    }
  });

  it('rejects missing --tenant', () => {
    expect(() =>
      parseOpsArgs([
        'fiscal:set',
        '--ruc',
        '4490207-7',
        '--legal-name',
        'Acme SA',
        '--taxpayer-type',
        'juridica',
        '--activity',
        '62010:Programación informática',
      ]),
    ).toThrow(OpsArgError);
  });

  it('rejects missing --ruc', () => {
    expect(() =>
      parseOpsArgs([
        'fiscal:set',
        '--tenant',
        't-1',
        '--legal-name',
        'Acme SA',
        '--taxpayer-type',
        'juridica',
        '--activity',
        '62010:Programación informática',
      ]),
    ).toThrow(OpsArgError);
  });

  it('rejects missing --legal-name', () => {
    expect(() =>
      parseOpsArgs([
        'fiscal:set',
        '--tenant',
        't-1',
        '--ruc',
        '4490207-7',
        '--taxpayer-type',
        'juridica',
        '--activity',
        '62010:Programación informática',
      ]),
    ).toThrow(OpsArgError);
  });

  it('rejects missing --taxpayer-type', () => {
    expect(() =>
      parseOpsArgs([
        'fiscal:set',
        '--tenant',
        't-1',
        '--ruc',
        '4490207-7',
        '--legal-name',
        'Acme SA',
        '--activity',
        '62010:Programación informática',
      ]),
    ).toThrow(OpsArgError);
  });

  it('rejects a --taxpayer-type other than fisica/juridica', () => {
    expect(() =>
      parseOpsArgs([
        'fiscal:set',
        '--tenant',
        't-1',
        '--ruc',
        '4490207-7',
        '--legal-name',
        'Acme SA',
        '--taxpayer-type',
        'empresa',
        '--activity',
        '62010:Programación informática',
      ]),
    ).toThrow(OpsArgError);
  });

  it('rejects an --activity without the "<code>:<description>" separator', () => {
    expect(() =>
      parseOpsArgs([
        'fiscal:set',
        '--tenant',
        't-1',
        '--ruc',
        '4490207-7',
        '--legal-name',
        'Acme SA',
        '--taxpayer-type',
        'juridica',
        '--activity',
        '62010 sin separador',
      ]),
    ).toThrow(OpsArgError);
  });

  it('rejects zero activities', () => {
    expect(() =>
      parseOpsArgs([
        'fiscal:set',
        '--tenant',
        't-1',
        '--ruc',
        '4490207-7',
        '--legal-name',
        'Acme SA',
        '--taxpayer-type',
        'juridica',
      ]),
    ).toThrow();
  });

  it('rejects more than 9 activities', () => {
    const tenActivities = Array.from({ length: 10 }, (_, i) => [
      '--activity',
      `act${String(i)}:Descripción ${String(i)}`,
    ]).flat();

    expect(() =>
      parseOpsArgs([
        'fiscal:set',
        '--tenant',
        't-1',
        '--ruc',
        '4490207-7',
        '--legal-name',
        'Acme SA',
        '--taxpayer-type',
        'juridica',
        ...tenActivities,
      ]),
    ).toThrow();
  });

  it('rejects an invalid RUC check digit', () => {
    expect(() =>
      parseOpsArgs([
        'fiscal:set',
        '--tenant',
        't-1',
        '--ruc',
        '4490207-1',
        '--legal-name',
        'Acme SA',
        '--taxpayer-type',
        'juridica',
        '--activity',
        '62010:Programación informática',
      ]),
    ).toThrow();
  });
});

describe('getOpsDatabaseUrl (HU-E1-05)', () => {
  it('returns OPS_DATABASE_URL when set', () => {
    expect(getOpsDatabaseUrl({ OPS_DATABASE_URL: 'postgres://owner@host/db' })).toBe(
      'postgres://owner@host/db',
    );
  });

  it('throws when OPS_DATABASE_URL is unset, even if DATABASE_URL is', () => {
    expect(() => getOpsDatabaseUrl({ DATABASE_URL: 'postgres://app_login@host/db' })).toThrow(
      OpsArgError,
    );
  });
});
