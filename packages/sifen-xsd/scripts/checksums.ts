import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * Shared sha256/manifest helpers reused by `verify-checksums.ts` (integrity
 * check) and `refresh-xsd.ts` (writes `vendor/checksums.json`).
 */

export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export async function sha256File(filePath: string): Promise<string> {
  const data = await readFile(filePath);
  return sha256Hex(data);
}

export type ChecksumManifest = Readonly<Record<string, string>>;

export async function readManifest(manifestPath: string): Promise<ChecksumManifest> {
  const raw = await readFile(manifestPath, 'utf8');
  return JSON.parse(raw) as ChecksumManifest;
}
