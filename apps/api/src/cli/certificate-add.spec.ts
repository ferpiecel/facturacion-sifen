import { createPgliteDatabase, tenantCertificates, type DatabaseHandle } from '@sifen/db';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestAuthority,
  issueTestPkcs12,
  type TestAuthority,
} from '../../test/support/test-pki.js';
import { createFiscalProfile } from '../modules/fiscal-config/domain/fiscal-profile.js';
import { parseRuc } from '../modules/fiscal-config/domain/ruc.js';
import { createTenant, setFiscalProfile } from './commands.js';
import { runCli } from './ops.js';

const PASSWORD = 'p12-super-secret';
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
const P12_PATH = '/secure/tenant.p12';
const ROOTS_PATH = '/etc/sifen/psc.pem';

let psc: TestAuthority;
beforeAll(() => {
  psc = createTestAuthority('Test PSC Root');
});

/** Spec: HU-E3-01 (slice 2). `certificate:add` seals a validated .p12; the password only comes from stdin. */
describe('runCli certificate:add', () => {
  let handle: DatabaseHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  interface RunOptions {
    argv?: (tenantId: string) => string[];
    stdin?: string;
    env?: NodeJS.ProcessEnv;
    p12?: Buffer;
    profile?: boolean;
    /** Reuse the tenant of an earlier run. */
    after?: { db: DatabaseHandle['db']; tenantId: string };
  }

  async function run(options: RunOptions = {}) {
    const { stdin = `${PASSWORD}\n`, profile = true } = options;
    const p12 =
      options.p12 ?? issueTestPkcs12(psc, { serialNumber: 'RUC80000005-6' }, PASSWORD).p12;
    let db: DatabaseHandle['db'];
    let tenantId: string;
    if (options.after) {
      ({ db, tenantId } = options.after);
    } else {
      handle = createPgliteDatabase();
      await handle.migrate();
      db = handle.db;
      ({ id: tenantId } = await createTenant(db, 'Cert Tenant'));
      if (profile) {
        await setFiscalProfile(db, {
          tenantId,
          profile: createFiscalProfile({
            ruc: parseRuc('80000005-6'),
            legalName: 'Tenant S.A.',
            taxpayerType: 'persona_juridica',
            economicActivities: [],
          }),
        });
      }
    }
    const out: string[] = [];
    const err: string[] = [];
    const files = new Map([
      [P12_PATH, p12],
      [ROOTS_PATH, Buffer.from(psc.pem)],
    ]);
    const code = await runCli({
      argv: (options.argv ?? args)(tenantId),
      env: {
        OPS_DATABASE_URL: 'x',
        KMS_LOCAL_MASTER_KEY: MASTER_KEY,
        NODE_ENV: 'test',
        PSC_TRUSTED_ROOTS_PATH: ROOTS_PATH,
        ...options.env,
      },
      readStdin: () => Promise.resolve(stdin),
      readFile: (path) => {
        const file = files.get(path);
        if (!file) throw new Error(`ENOENT ${path}`);
        return file;
      },
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      openDb: () => ({ db, close: () => Promise.resolve() }),
    });
    return { code, out: out.join('\n'), err: err.join('\n'), tenantId, db };
  }

  const args = (tenantId: string, extra: string[] = []) => [
    'certificate:add',
    '--tenant',
    tenantId,
    '--env',
    'test',
    '--p12',
    P12_PATH,
    '--password',
    '-',
    ...extra,
  ];

  it('seals a valid certificate, prints its public facts and never the password', async () => {
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.out).toContain('certificate stored');
    expect(result.out).toContain('80000005-6');
    const rows = await result.db.select().from(tenantCertificates);
    expect(rows).toHaveLength(1);
    expect(result.out).toContain(rows[0].fingerprint);
    expect(result.out + result.err + JSON.stringify(rows)).not.toContain(PASSWORD);
  });

  it('refuses a password on argv in both spellings, without echoing it', async () => {
    const spaced = await run({ argv: (t) => args(t).map((a) => (a === '-' ? 'argv-secret' : a)) });
    const equals = await run({
      argv: (t) => [
        'certificate:add',
        '--tenant',
        t,
        '--env',
        'test',
        '--p12',
        P12_PATH,
        '--password=argv-secret',
      ],
    });
    for (const result of [spaced, equals]) {
      expect(result.code).toBe(1);
      expect(result.err).toContain('stdin');
      expect(result.out + result.err).not.toContain('argv-secret');
    }
  });

  it('refuses an invalid certificate and lists the validator reasons', async () => {
    const wrongRuc = issueTestPkcs12(psc, { serialNumber: 'RUC80000006-4' }, PASSWORD).p12;
    const result = await run({ p12: wrongRuc });
    expect(result.code).toBe(1);
    expect(result.err).toContain('ruc-mismatch');
    expect(result.err).toContain('80000005-6');
    expect(await result.db.select().from(tenantCertificates)).toEqual([]);
  });

  it('fails on a wrong password without echoing it', async () => {
    const result = await run({ stdin: 'not-the-password\n' });
    expect(result.code).toBe(1);
    expect(result.err).toContain('could not be opened');
    expect(result.out + result.err).not.toContain('not-the-password');
  });

  it('fails closed without the PSC roots, the master key or the .p12 file', async () => {
    const noRoots = await run({ env: { PSC_TRUSTED_ROOTS_PATH: '' } });
    expect(noRoots.err).toContain('PSC_TRUSTED_ROOTS_PATH');
    const noKey = await run({ env: { KMS_LOCAL_MASTER_KEY: '' } });
    expect(noKey.err).toContain('KMS_LOCAL_MASTER_KEY');
    const noFile = await run({
      argv: (t) => args(t).map((a) => (a === P12_PATH ? '/nope.p12' : a)),
    });
    expect(noFile.err).toContain('--p12');
    for (const result of [noRoots, noKey, noFile]) {
      expect(result.code).toBe(1);
      expect(await result.db.select().from(tenantCertificates)).toEqual([]);
    }
  });

  it('refuses a tenant without a fiscal profile', async () => {
    const result = await run({ profile: false });
    expect(result.code).toBe(1);
    expect(result.err).toContain('fiscal profile');
  });

  it('refuses a second active certificate unless --replace is given', async () => {
    const first = await run();
    expect(first.code).toBe(0);
    const again = await run({ after: first });
    expect(again.code).toBe(1);
    expect(again.err).toContain('active certificate');

    const replaced = await run({ after: first, argv: (t) => args(t, ['--replace']) });
    expect(replaced.code).toBe(0);
    const rows = await first.db.select().from(tenantCertificates);
    expect(rows.map((r) => r.status).sort()).toEqual(['active', 'revoked']);
  });
});
