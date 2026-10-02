import { createPgliteDatabase, type DatabaseHandle } from '@sifen/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createEstablishment } from '../modules/fiscal-config/domain/establishment.js';
import { createExpeditionPoint } from '../modules/fiscal-config/domain/expedition-point.js';
import { createFiscalProfile } from '../modules/fiscal-config/domain/fiscal-profile.js';
import { parseRuc } from '../modules/fiscal-config/domain/ruc.js';
import { createTimbrado } from '../modules/fiscal-config/domain/timbrado.js';
import { addEstablishment, createTenant } from './commands.js';
import { tenantCscs } from '@sifen/db';
import { EnvelopeCipher } from '../modules/custody/application/envelope-cipher.js';
import { createLocalKms } from '../modules/custody/infrastructure/adapters/local-kms.adapter.js';
import { CscVault } from '../modules/custody/infrastructure/csc-vault.js';
import { createCscVault, formatOpsError, runCli, runOpsCommand } from './ops.js';

describe('runOpsCommand (HU-E1-05)', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('partner:create prints the new partner id', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();

    const output = await runOpsCommand(handle.db, { kind: 'partner:create', name: 'Acme' });

    expect(output).toMatch(/partner created: [0-9a-f-]{36}/);
  });

  it('tenant:create prints the new tenant id', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();

    const output = await runOpsCommand(handle.db, {
      kind: 'tenant:create',
      name: 'Direct',
      partnerId: undefined,
    });

    expect(output).toMatch(/tenant created: [0-9a-f-]{36}/);
  });

  it('apikey:create prints the plaintext key exactly once, plus a warning it cannot be retrieved again', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Key Tenant');

    const output = await runOpsCommand(handle.db, {
      kind: 'apikey:create',
      tenantId,
      environment: 'test',
      scopes: ['documents:write'],
      label: undefined,
    });

    expect(output).toMatch(/^sk_test_/m);
    expect(output.toLowerCase()).toContain('cannot be retrieved again');
  });

  it('apikey:revoke prints a confirmation and never the secret', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Revoke Tenant');
    const issued = await runOpsCommand(handle.db, {
      kind: 'apikey:create',
      tenantId,
      environment: 'test',
      scopes: [],
      label: undefined,
    });
    const keyIdMatch = /sk_test_([A-Za-z0-9]{32})_/.exec(issued);
    const keyId = keyIdMatch?.[1] ?? '';

    const output = await runOpsCommand(handle.db, { kind: 'apikey:revoke', keyId });

    expect(output).toMatch(/revoked/i);
    expect(output).not.toContain('sk_test_');
  });

  it('fiscal:set prints the tenant id and formatted RUC', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Fiscal Tenant');
    const profile = createFiscalProfile({
      ruc: parseRuc('4490207-7'),
      legalName: 'Acme SA',
      taxpayerType: 'persona_juridica',
      economicActivities: [{ code: '62010', description: 'Programación informática' }],
    });

    const output = await runOpsCommand(handle.db, { kind: 'fiscal:set', tenantId, profile });

    expect(output).toBe(`fiscal profile saved: ${tenantId} (RUC 4490207-7)`);
  });

  it('establishment:add prints the new establishment id and code', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Establishment Tenant');
    const establishment = createEstablishment({
      code: '001',
      address: 'Avda. Siempre Viva 123',
      houseNumber: '123',
      departmentCode: 11,
      districtCode: '145',
      districtDescription: 'Ciudad del Este',
      cityCode: '3316',
      cityDescription: 'Ciudad del Este',
    });

    const output = await runOpsCommand(handle.db, {
      kind: 'establishment:add',
      tenantId,
      establishment,
    });

    expect(output).toMatch(/^establishment created: [0-9a-f-]{36} \(code 001\)$/);
  });

  it('point:add prints the new expedition point id and code', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Point Tenant');
    await addEstablishment(handle.db, {
      tenantId,
      establishment: createEstablishment({
        code: '001',
        address: 'Avda. Siempre Viva 123',
        houseNumber: '123',
        departmentCode: 11,
        districtCode: '145',
        districtDescription: 'Ciudad del Este',
        cityCode: '3316',
        cityDescription: 'Ciudad del Este',
      }),
    });

    const output = await runOpsCommand(handle.db, {
      kind: 'point:add',
      tenantId,
      establishmentCode: '001',
      point: createExpeditionPoint({ code: '002' }),
    });

    expect(output).toMatch(/^expedition point created: [0-9a-f-]{36} \(code 002\)$/);
  });

  it('timbrado:add prints the new timbrado id and number', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Timbrado Tenant');
    const timbrado = createTimbrado({ number: '12345678', validityStart: '2024-01-01' });

    const output = await runOpsCommand(handle.db, { kind: 'timbrado:add', tenantId, timbrado });

    expect(output).toMatch(/^timbrado created: [0-9a-f-]{36} \(number 12345678\)$/);
  });

  it('tenant:environment prints the tenant id and new environment', async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Env Tenant');

    const output = await runOpsCommand(handle.db, {
      kind: 'tenant:environment',
      tenantId,
      environment: 'production',
    });

    expect(output).toBe(`tenant environment set: ${tenantId} (production)`);
  });
});

describe('formatOpsError (HU-E1-05)', () => {
  it('prints the driver cause, never the failed query params', () => {
    const driverError = new Error('insert or update on table "api_keys" violates foreign key');
    const queryError = new Error(
      'Failed query: insert into "api_keys"\nparams: keyId,$argon2id$hash',
      {
        cause: driverError,
      },
    );

    const message = formatOpsError(queryError);

    expect(message).toBe('insert or update on table "api_keys" violates foreign key');
    expect(message).not.toContain('argon2');
  });

  it('hides a failed query without a cause behind a generic message', () => {
    expect(formatOpsError(new Error('Failed query: select 1\nparams: secret'))).toBe(
      'database query failed',
    );
  });

  it('keeps plain operator errors as they are', () => {
    expect(formatOpsError(new Error('missing required --name'))).toBe('missing required --name');
  });

  it('describes a non-Error rejection generically', () => {
    expect(formatOpsError('boom')).toBe('unknown error');
  });
});

const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

describe('csc:add (HU-E2-03)', () => {
  const CSC = 'ABCD0000000000000000000000000000';
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function setup() {
    handle = createPgliteDatabase();
    await handle.migrate();
    const { id: tenantId } = await createTenant(handle.db, 'Csc Tenant');
    const vault = new CscVault(
      new EnvelopeCipher(createLocalKms(undefined, 'test', () => undefined)),
    );
    const command = (idCsc: string) =>
      ({ kind: 'csc:add', tenantId, environment: 'test', idCsc, csc: CSC }) as const;
    return { db: handle.db, vault, tenantId, command };
  }

  it('seals the CSC, prints a confirmation without the value, and decrypts back', async () => {
    const { db, vault, tenantId, command } = await setup();

    const output = await runOpsCommand(db, command('0001'), vault);

    expect(output).toContain('0001');
    expect(output).not.toContain(CSC);
    expect(JSON.stringify(await db.select().from(tenantCscs))).not.toContain(CSC);
    expect((await vault.getPlaintext(db, tenantId, 'test', '0001')).toString('utf8')).toBe(CSC);
  });

  it('fails clearly, without the value, when both slots are already used', async () => {
    const { db, vault, command } = await setup();
    await runOpsCommand(db, command('0001'), vault);
    await runOpsCommand(db, command('0002'), vault);

    const error = await runOpsCommand(db, command('0003'), vault).catch((e: unknown) => e);

    expect(formatOpsError(error)).toContain('already has 2 CSC');
    expect(formatOpsError(error)).not.toContain(CSC);
  });

  it('refuses to run without a vault', async () => {
    const { db, command } = await setup();
    await expect(runOpsCommand(db, command('0001'))).rejects.toThrow(/vault/);
  });

  it('builds the vault with the API KMS rules: fail closed outside development/test', () => {
    expect(() => createCscVault({ NODE_ENV: 'production' })).toThrow(/KMS_LOCAL_MASTER_KEY/);
    expect(() => createCscVault({})).toThrow(/KMS_LOCAL_MASTER_KEY/);
    expect(createCscVault({ NODE_ENV: 'test', KMS_LOCAL_MASTER_KEY: MASTER_KEY })).toBeInstanceOf(
      CscVault,
    );
  });

  it('requires KMS_LOCAL_MASTER_KEY even in development/test (a throwaway key loses the CSC)', () => {
    expect(() => createCscVault({ NODE_ENV: 'test' })).toThrow(/KMS_LOCAL_MASTER_KEY/);
    expect(() => createCscVault({ NODE_ENV: 'development' })).toThrow(/KMS_LOCAL_MASTER_KEY/);
  });

  it('fails for an unknown tenant without the value', async () => {
    const { db, vault } = await setup();
    const error = await runOpsCommand(
      db,
      {
        kind: 'csc:add',
        tenantId: '00000000-0000-4000-8000-000000000000',
        environment: 'test',
        idCsc: '0001',
        csc: CSC,
      },
      vault,
    ).catch((e: unknown) => e);
    expect(formatOpsError(error)).toContain('tenant not found');
    expect(formatOpsError(error)).not.toContain(CSC);
  });
});

describe('runCli csc:add (HU-E2-03)', () => {
  const CSC = 'ABCD0000000000000000000000000000';
  // One migrated database for the whole block (migrating costs seconds, esp. under coverage);
  // every scenario gets its own tenant, so they stay independent.
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
  });

  afterAll(async () => {
    await handle.close();
  });

  async function run(argv: (tenantId: string) => string[], stdin = '', key = MASTER_KEY) {
    const { id: tenantId } = await createTenant(handle.db, 'Cli Tenant');
    const out: string[] = [];
    const err: string[] = [];
    const db = handle.db;
    const code = await runCli({
      argv: argv(tenantId),
      env: { OPS_DATABASE_URL: 'x', KMS_LOCAL_MASTER_KEY: key, NODE_ENV: 'test' },
      readStdin: () => Promise.resolve(stdin),
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      openDb: () => ({ db, close: () => Promise.resolve() }),
    });
    return { code, out: out.join('\n'), err: err.join('\n'), tenantId, db };
  }

  const args = (tenantId: string, csc: string) => [
    'csc:add',
    '--tenant',
    tenantId,
    '--env',
    'test',
    '--id',
    '0001',
    '--csc',
    csc,
  ];

  it('succeeds without printing the CSC', async () => {
    const result = await run((t) => args(t, CSC));
    expect(result.code).toBe(0);
    expect(result.out).toContain('csc stored');
    expect(result.out + result.err).not.toContain(CSC);
  });

  it('reads the CSC from stdin with --csc - and ignores the trailing newline', async () => {
    const result = await run((t) => args(t, '-'), `${CSC}\n`);
    expect(result.code).toBe(0);
    expect(result.out + result.err).not.toContain(CSC);
    expect(JSON.stringify(await result.db.select().from(tenantCscs))).not.toContain(CSC);
  });

  const expectFailure = (result: { code: number; out: string; err: string }) => {
    expect(result.code).toBe(1);
    expect(result.err).not.toBe('');
    expect(result.out + result.err).not.toContain(CSC);
  };

  it('fails on a stray positional without leaking the CSC', async () => {
    expectFailure(
      await run((t) => ['csc:add', '--tenant', t, '--env', 'test', '--id', '0001', CSC]),
    );
  });

  it('fails for an unknown tenant without leaking the CSC', async () => {
    expectFailure(await run(() => args('00000000-0000-4000-8000-000000000000', CSC)));
  });

  it('fails without the master key, naming it, without leaking the CSC', async () => {
    const result = await run((t) => args(t, CSC), '', '');
    expectFailure(result);
    expect(result.err).toContain('KMS_LOCAL_MASTER_KEY');
  });

  it('fails on a malformed stdin CSC without leaking it', async () => {
    expectFailure(await run((t) => args(t, '-'), 'short\n'));
  });
});
