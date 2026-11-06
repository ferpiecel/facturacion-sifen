import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(root, 'fixtures.manifest.json');
const fixtureRoots = ['sifen', 'ekuatia'];

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function onDisk(): Record<string, string> {
  const entries = fixtureRoots
    .flatMap((r) => listFiles(join(root, r)))
    .map((f) => relative(root, f).split(sep).join('/'))
    .sort()
    .map((rel): [string, string] => [rel, sha256(join(root, rel))]);
  return Object.fromEntries(entries);
}

describe('reception golden fixtures manifest', () => {
  it('has a manifest file', () => {
    expect(existsSync(manifestPath)).toBe(true);
  });

  const manifest: Record<string, string> = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, string>)
    : {};
  const actual = onDisk();

  it('lists the manifest paths in sorted order', () => {
    const keys = Object.keys(manifest);
    expect(keys).toEqual([...keys].sort());
  });

  it('has no fixture file missing from the manifest', () => {
    const extra = Object.keys(actual).filter((k) => !(k in manifest));
    expect(extra).toEqual([]);
  });

  it('has no manifest entry without a fixture file', () => {
    const missing = Object.keys(manifest).filter((k) => !(k in actual));
    expect(missing).toEqual([]);
  });

  it('keeps every fixture byte-identical to its recorded sha256', () => {
    const changed = Object.keys(manifest).filter((k) => k in actual && actual[k] !== manifest[k]);
    expect(changed).toEqual([]);
  });

  it('covers at least the SIFEN and eKuatia golden sets', () => {
    expect(Object.keys(manifest).length).toBeGreaterThan(0);
    expect(actual['sifen/factura_contado/documento.xml']).toBeDefined();
    expect(actual['ekuatia/v2026-Q3/success/requests.json']).toBeDefined();
  });
});
