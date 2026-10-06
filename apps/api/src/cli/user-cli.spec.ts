import { auditLog, createPgliteDatabase, users, type DatabaseHandle } from '@sifen/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenant } from './commands.js';
import { runCli } from './ops.js';

const PASSWORD = 'correct horse battery staple';

describe('runCli user:create (HU-E1-07)', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
  });

  afterAll(async () => {
    await handle.close();
  });

  async function run(argv: (tenantId: string) => string[], stdin = '') {
    const { id: tenantId } = await createTenant(handle.db, 'Cli Tenant');
    const out: string[] = [];
    const err: string[] = [];
    const db = handle.db;
    const code = await runCli({
      argv: argv(tenantId),
      env: { OPS_DATABASE_URL: 'x' },
      readStdin: () => Promise.resolve(stdin),
      readFile: () => Buffer.alloc(0),
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      openDb: () => ({ db, close: () => Promise.resolve() }),
    });
    return { code, out: out.join('\n'), err: err.join('\n'), tenantId };
  }

  const args = (tenantId: string, email: string, ...extra: string[]) => [
    'user:create',
    '--tenant',
    tenantId,
    '--email',
    email,
    '--name',
    'Ana',
    '--role',
    'owner',
    ...extra,
  ];

  it('reads the password from stdin, stores only its hash and never prints it', async () => {
    const result = await run(
      (t) => args(t, 'cli1@example.com', '--password', '-'),
      `${PASSWORD}\n`,
    );

    expect(result.code).toBe(0);
    expect(result.out).toContain('user created');
    expect(result.out + result.err).not.toContain(PASSWORD);
    const rows = await handle.db.select().from(users);
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
    const audit = await handle.db.select().from(auditLog);
    expect(JSON.stringify(audit)).not.toContain(PASSWORD);
  });

  it('refuses a password passed on argv, without echoing it', async () => {
    const result = await run((t) => args(t, 'cli2@example.com', '--password', PASSWORD));

    expect(result.code).toBe(1);
    expect(result.err).toContain('stdin');
    expect(result.out + result.err).not.toContain(PASSWORD);
  });

  it('reports a weak password by rule code without echoing it', async () => {
    const result = await run((t) => args(t, 'cli3@example.com', '--password', '-'), 'short\n');

    expect(result.code).toBe(1);
    expect(result.err).toContain('too_short');
    expect(result.err).not.toContain('short\n');
  });
});
