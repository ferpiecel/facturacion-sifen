import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resultExitCode, verifyVendorDirectory } from '../scripts/verify-checksums.ts';
import { sha256Hex } from '../scripts/checksums.ts';

const FILE_A = 'schema-a.xsd';
const FILE_B = 'schema-b.xsd';
const CONTENT_A = '<xsd:schema>a</xsd:schema>';
const CONTENT_B = '<xsd:schema>b</xsd:schema>';

async function makeVendorDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sifen-xsd-verify-'));
  await writeFile(join(dir, FILE_A), CONTENT_A, 'utf8');
  await writeFile(join(dir, FILE_B), CONTENT_B, 'utf8');
  await writeFile(
    join(dir, 'checksums.json'),
    JSON.stringify(
      {
        [FILE_A]: sha256Hex(Buffer.from(CONTENT_A, 'utf8')),
        [FILE_B]: sha256Hex(Buffer.from(CONTENT_B, 'utf8')),
      },
      null,
      2,
    ),
    'utf8',
  );
  return dir;
}

describe('verifyVendorDirectory', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeVendorDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('passes and exits 0 when every file matches its recorded checksum', async () => {
    const result = await verifyVendorDirectory(dir);

    expect(result).toEqual({ ok: true, mismatched: [], missing: [], extra: [] });
    expect(resultExitCode(result)).toBe(0);
  });

  it('reports a non-zero exit and names the file on a tampered byte', async () => {
    await writeFile(join(dir, FILE_A), 'TAMPERED', 'utf8');

    const result = await verifyVendorDirectory(dir);

    expect(result.ok).toBe(false);
    expect(result.mismatched).toEqual([FILE_A]);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
    expect(resultExitCode(result)).toBe(1);
  });

  it('reports a non-zero exit and names the file when it is missing', async () => {
    await rm(join(dir, FILE_B));

    const result = await verifyVendorDirectory(dir);

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([FILE_B]);
    expect(result.mismatched).toEqual([]);
    expect(result.extra).toEqual([]);
    expect(resultExitCode(result)).toBe(1);
  });

  it('reports a non-zero exit and names the file when an untracked extra file is present', async () => {
    await writeFile(join(dir, 'extra-file.xsd'), '<xsd:schema/>', 'utf8');

    const result = await verifyVendorDirectory(dir);

    expect(result.ok).toBe(false);
    expect(result.extra).toEqual(['extra-file.xsd']);
    expect(result.mismatched).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(resultExitCode(result)).toBe(1);
  });
});
