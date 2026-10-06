import { describe, expect, it } from 'vitest';
import { OpsArgError, parseOpsArgs } from './args.js';
import { MAX_STDIN_SECRET_LENGTH, resolveStdinSecrets } from './ops.js';

const TENANT = '4f6c1e0a-5b6d-4c1e-8f6a-0a1b2c3d4e5f';
const user = (...extra: string[]) => [
  'user:create',
  '--tenant',
  TENANT,
  '--email',
  'a@example.com',
  '--name',
  'Ana',
  '--role',
  'owner',
  ...extra,
];
const stdin = (text: string) => () => Promise.resolve(text);

describe('resolveStdinSecrets (HU-E1-07)', () => {
  it('delivers a stdin password that starts with a dash intact, for user:create', async () => {
    const argv = await resolveStdinSecrets(
      user('--password', '-'),
      stdin('-correct horse battery\n'),
    );
    expect(parseOpsArgs(argv)).toMatchObject({
      kind: 'user:create',
      password: '-correct horse battery',
    });
  });

  it('delivers it intact for certificate:add too', async () => {
    const argv = await resolveStdinSecrets(
      [
        'certificate:add',
        '--tenant',
        TENANT,
        '--env',
        'test',
        '--p12',
        '/x.p12',
        '--password',
        '-',
      ],
      stdin('--p12pass\n'),
    );
    expect(parseOpsArgs(argv)).toMatchObject({ kind: 'certificate:add', password: '--p12pass' });
  });

  it('rejects --password given twice, however the second one is spelled, without echoing it', async () => {
    for (const extra of [['--password', 'secret'], ['--password=secret']]) {
      const error = await resolveStdinSecrets(
        user('--password', '-', ...extra),
        stdin('x\n'),
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(OpsArgError);
      expect(String(error)).not.toContain('secret');
    }
  });

  it('rejects a stdin secret above the size limit', async () => {
    const huge = 'a'.repeat(MAX_STDIN_SECRET_LENGTH + 1);
    await expect(resolveStdinSecrets(user('--password', '-'), stdin(huge))).rejects.toThrow(
      /larger than/,
    );
  });
});
