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
  type FlagMap = Record<string, string | string[] | undefined>;
  const baseFlags: FlagMap = {
    tenant: 't-1',
    ruc: '4490207-7',
    'legal-name': 'Acme SA',
    'taxpayer-type': 'juridica',
    activity: '62010:Programación informática',
  };

  function argsFor(overrides: FlagMap): string[] {
    const flags: FlagMap = { ...baseFlags, ...overrides };
    return [
      'fiscal:set',
      ...Object.entries(flags).flatMap(([flag, value]) =>
        value === undefined
          ? []
          : (Array.isArray(value) ? value : [value]).flatMap((v) => [`--${flag}`, v]),
      ),
    ];
  }

  it('parses a full fiscal:set command', () => {
    const command = parseOpsArgs(
      argsFor({
        'trade-name': 'Acme',
        regime: '1',
        activity: ['62010:Programación informática', '62020:Consultoría informática'],
      }),
    );

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
    const command = parseOpsArgs(argsFor({ 'taxpayer-type': 'fisica' }));

    expect(command.kind).toBe('fiscal:set');
    if (command.kind === 'fiscal:set') {
      expect(command.profile.taxpayerType).toBe('persona_fisica');
      expect(command.profile.tradeName).toBeNull();
      expect(command.profile.regimeCode).toBeNull();
    }
  });

  it.each([
    ['tenant', undefined],
    ['ruc', undefined],
    ['legal-name', undefined],
    ['taxpayer-type', undefined],
    ['taxpayer-type', 'empresa'],
  ])('rejects flag %s = %s', (flag, value) => {
    expect(() => parseOpsArgs(argsFor({ [flag]: value }))).toThrow(OpsArgError);
  });

  it('rejects an --activity without the "<code>:<description>" separator', () => {
    expect(() => parseOpsArgs(argsFor({ activity: '62010 sin separador' }))).toThrow(OpsArgError);
  });

  it('rejects zero activities', () => {
    expect(() => parseOpsArgs(argsFor({ activity: undefined }))).toThrow();
  });

  it('rejects more than 9 activities', () => {
    const tenActivities = Array.from(
      { length: 10 },
      (_, i) => `act${String(i)}:Descripción ${String(i)}`,
    );

    expect(() => parseOpsArgs(argsFor({ activity: tenActivities }))).toThrow();
  });

  it('rejects an invalid RUC check digit', () => {
    expect(() => parseOpsArgs(argsFor({ ruc: '4490207-1' }))).toThrow();
  });
});

describe('parseOpsArgs establishment:add (HU-E2-02)', () => {
  type FlagMap = Record<string, string | undefined>;
  const baseFlags: FlagMap = {
    tenant: 't-1',
    code: '001',
    address: 'Avda. Siempre Viva 123',
    'house-number': '123',
    department: '11',
    district: '145',
    'district-description': 'Ciudad del Este',
    city: '3316',
    'city-description': 'Ciudad del Este',
  };

  function argsFor(overrides: FlagMap): string[] {
    const flags: FlagMap = { ...baseFlags, ...overrides };
    return [
      'establishment:add',
      ...Object.entries(flags).flatMap(([flag, value]) =>
        value === undefined ? [] : [`--${flag}`, value],
      ),
    ];
  }

  it('parses a full establishment:add command', () => {
    const command = parseOpsArgs(
      argsFor({ 'address-complement-1': 'Casi Av. Mcal. Lopez', 'address-complement-2': 'Piso 2' }),
    );

    expect(command).toEqual({
      kind: 'establishment:add',
      tenantId: 't-1',
      establishment: {
        code: '001',
        address: 'Avda. Siempre Viva 123',
        houseNumber: '123',
        addressComplement1: 'Casi Av. Mcal. Lopez',
        addressComplement2: 'Piso 2',
        departmentCode: 11,
        departmentDescription: 'ALTO PARANA',
        districtCode: '145',
        districtDescription: 'Ciudad del Este',
        cityCode: '3316',
        cityDescription: 'Ciudad del Este',
      },
    });
  });

  it('parses establishment:add without district/district-description (both optional)', () => {
    const command = parseOpsArgs(
      argsFor({ district: undefined, 'district-description': undefined }),
    );

    expect(command).toEqual({
      kind: 'establishment:add',
      tenantId: 't-1',
      establishment: {
        code: '001',
        address: 'Avda. Siempre Viva 123',
        houseNumber: '123',
        addressComplement1: null,
        addressComplement2: null,
        departmentCode: 11,
        departmentDescription: 'ALTO PARANA',
        districtCode: null,
        districtDescription: null,
        cityCode: '3316',
        cityDescription: 'Ciudad del Este',
      },
    });
  });

  it.each([
    ['tenant', undefined],
    ['code', undefined],
    ['address', undefined],
    ['house-number', undefined],
    ['department', undefined],
    ['city', undefined],
    ['city-description', undefined],
  ])('rejects missing --%s', (flag) => {
    expect(() => parseOpsArgs(argsFor({ [flag]: undefined }))).toThrow(OpsArgError);
  });

  it('rejects --district without --district-description', () => {
    expect(() => parseOpsArgs(argsFor({ 'district-description': undefined }))).toThrow(OpsArgError);
  });

  it('rejects --district-description without --district', () => {
    expect(() => parseOpsArgs(argsFor({ district: undefined }))).toThrow(OpsArgError);
  });

  it('rejects a non-numeric --department', () => {
    expect(() => parseOpsArgs(argsFor({ department: 'abc' }))).toThrow(OpsArgError);
  });

  it('rejects an unknown --department code (domain validation)', () => {
    expect(() => parseOpsArgs(argsFor({ department: '99' }))).toThrow();
  });

  it('rejects an invalid --code (domain validation)', () => {
    expect(() => parseOpsArgs(argsFor({ code: '000' }))).toThrow();
  });
});

describe('parseOpsArgs point:add (HU-E2-02)', () => {
  it('parses a point:add command', () => {
    expect(
      parseOpsArgs(['point:add', '--tenant', 't-1', '--establishment', '001', '--code', '002']),
    ).toEqual({
      kind: 'point:add',
      tenantId: 't-1',
      establishmentCode: '001',
      point: { code: '002' },
    });
  });

  it.each([
    ['tenant', undefined],
    ['establishment', undefined],
    ['code', undefined],
  ])('rejects missing --%s', (flag) => {
    const flags: Record<string, string | undefined> = {
      tenant: 't-1',
      establishment: '001',
      code: '002',
      [flag]: undefined,
    };
    const args = [
      'point:add',
      ...Object.entries(flags).flatMap(([f, v]) => (v === undefined ? [] : [`--${f}`, v])),
    ];
    expect(() => parseOpsArgs(args)).toThrow(OpsArgError);
  });

  it('rejects an invalid --code (domain validation)', () => {
    expect(() =>
      parseOpsArgs(['point:add', '--tenant', 't-1', '--establishment', '001', '--code', '000']),
    ).toThrow();
  });
});

describe('parseOpsArgs timbrado:add (HU-E2-02)', () => {
  it('parses a full timbrado:add command', () => {
    expect(
      parseOpsArgs([
        'timbrado:add',
        '--tenant',
        't-1',
        '--number',
        '12345678',
        '--valid-from',
        '2024-01-01',
        '--valid-to',
        '2025-01-01',
      ]),
    ).toEqual({
      kind: 'timbrado:add',
      tenantId: 't-1',
      timbrado: { number: '12345678', validityStart: '2024-01-01', validityEnd: '2025-01-01' },
    });
  });

  it('parses timbrado:add without --valid-to', () => {
    const command = parseOpsArgs([
      'timbrado:add',
      '--tenant',
      't-1',
      '--number',
      '12345678',
      '--valid-from',
      '2024-01-01',
    ]);

    expect(command).toEqual({
      kind: 'timbrado:add',
      tenantId: 't-1',
      timbrado: { number: '12345678', validityStart: '2024-01-01', validityEnd: null },
    });
  });

  it.each([
    ['tenant', undefined],
    ['number', undefined],
    ['valid-from', undefined],
  ])('rejects missing --%s', (flag) => {
    const flags: Record<string, string | undefined> = {
      tenant: 't-1',
      number: '12345678',
      'valid-from': '2024-01-01',
      [flag]: undefined,
    };
    const args = [
      'timbrado:add',
      ...Object.entries(flags).flatMap(([f, v]) => (v === undefined ? [] : [`--${f}`, v])),
    ];
    expect(() => parseOpsArgs(args)).toThrow(OpsArgError);
  });

  it('rejects an impossible calendar date (domain validation)', () => {
    expect(() =>
      parseOpsArgs([
        'timbrado:add',
        '--tenant',
        't-1',
        '--number',
        '12345678',
        '--valid-from',
        '2024-02-30',
      ]),
    ).toThrow();
  });
});

describe('parseOpsArgs tenant:environment (HU-E2-04)', () => {
  it('parses a switch to "test" without --confirm-production', () => {
    expect(parseOpsArgs(['tenant:environment', '--tenant', 't-1', '--env', 'test'])).toEqual({
      kind: 'tenant:environment',
      tenantId: 't-1',
      environment: 'test',
    });
  });

  it('parses a switch to "production" with --confirm-production', () => {
    expect(
      parseOpsArgs([
        'tenant:environment',
        '--tenant',
        't-1',
        '--env',
        'production',
        '--confirm-production',
      ]),
    ).toEqual({ kind: 'tenant:environment', tenantId: 't-1', environment: 'production' });
  });

  it('rejects a switch to "production" without --confirm-production', () => {
    expect(() =>
      parseOpsArgs(['tenant:environment', '--tenant', 't-1', '--env', 'production']),
    ).toThrow(/--confirm-production/);
  });

  it('rejects an invalid --env', () => {
    expect(() =>
      parseOpsArgs(['tenant:environment', '--tenant', 't-1', '--env', 'staging']),
    ).toThrow(OpsArgError);
  });

  it.each([
    ['tenant', undefined],
    ['env', undefined],
  ])('rejects missing --%s', (flag) => {
    const flags: Record<string, string | undefined> = {
      tenant: 't-1',
      env: 'test',
      [flag]: undefined,
    };
    const args = [
      'tenant:environment',
      ...Object.entries(flags).flatMap(([f, v]) => (v === undefined ? [] : [`--${f}`, v])),
    ];
    expect(() => parseOpsArgs(args)).toThrow(OpsArgError);
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

describe('parseOpsArgs csc:add (HU-E2-03)', () => {
  const CSC = 'ABCD0000000000000000000000000000';
  const base = ['csc:add', '--tenant', 't-1', '--env', 'test', '--id', '0001', '--csc', CSC];

  it('parses tenant, environment, idCSC and CSC', () => {
    expect(parseOpsArgs(base)).toEqual({
      kind: 'csc:add',
      tenantId: 't-1',
      environment: 'test',
      idCsc: '0001',
      csc: CSC,
    });
  });

  it('rejects an invalid --env', () => {
    expect(() =>
      parseOpsArgs(['csc:add', '--tenant', 't-1', '--env', 'live', '--id', '0001', '--csc', CSC]),
    ).toThrow(OpsArgError);
  });

  it('rejects an invalid --id without echoing the CSC', () => {
    const argv = ['csc:add', '--tenant', 't-1', '--env', 'test', '--id', '12', '--csc', CSC];
    expect(() => parseOpsArgs(argv)).toThrow(/4 digits/);
  });

  it('rejects a malformed --csc without echoing it', () => {
    const argv = [
      'csc:add',
      '--tenant',
      't-1',
      '--env',
      'test',
      '--id',
      '0001',
      '--csc',
      'SECRET-short',
    ];
    let message = '';
    try {
      parseOpsArgs(argv);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/32 alphanumeric/);
    expect(message).not.toContain('SECRET-short');
  });

  it.each(['tenant', 'env', 'id', 'csc'])('rejects missing --%s', (flag) => {
    const argv = base.filter(
      (_, index, all) => all[index] !== `--${flag}` && all[index - 1] !== `--${flag}`,
    );
    expect(() => parseOpsArgs(argv)).toThrow(new RegExp(`--${flag}`));
  });
});

describe('parseOpsArgs never echoes argv values (HU-E2-03)', () => {
  const CSC = 'ABCD0000000000000000000000000000';

  it.each([
    ['csc:add', ['csc:add', '--tenant', 't-1', '--env', 'test', '--id', '0001', CSC]],
    ['partner:create', ['partner:create', '--name', 'Acme', CSC]],
  ])('rejects a stray positional in %s with a fixed message', (_name, argv) => {
    let message = '';
    try {
      parseOpsArgs(argv);
    } catch (error) {
      expect(error).toBeInstanceOf(OpsArgError);
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(CSC);
  });

  it('does not echo the value of a malformed option either', () => {
    let message = '';
    try {
      parseOpsArgs(['csc:add', `--csc=${CSC}`, '--bogus']);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(CSC);
  });
});
