import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FsGuideCatalog } from './fs-guide-catalog.adapter.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'guides-'));
  mkdirSync(join(root, 'adr'));
  writeFileSync(join(root, 'a.md'), '# A');
  writeFileSync(join(root, 'adr', 'b.md'), '# B');
  writeFileSync(join(root, 'x.pdf'), 'pdf');
  writeFileSync(join(root, 'notes.txt'), 'txt');
  return root;
}

describe('FsGuideCatalog', () => {
  it('lists only .md files, as sorted posix paths relative to the root', () => {
    expect(new FsGuideCatalog(fixture()).paths()).toEqual(['a.md', 'adr/b.md']);
  });

  it('reads only allowlisted paths', () => {
    const catalog = new FsGuideCatalog(fixture());
    expect(catalog.read('adr/b.md')).toBe('# B');
    for (const bad of ['../a.md', '/etc/passwd', 'x.pdf', 'adr/../a.md', 'missing.md', '']) {
      expect(catalog.read(bad), bad).toBeUndefined();
    }
  });

  it('is empty, not a crash, when the folder is missing or unset', () => {
    expect(new FsGuideCatalog(join(tmpdir(), 'does-not-exist-guides')).paths()).toEqual([]);
    expect(new FsGuideCatalog(undefined).paths()).toEqual([]);
  });

  it('skips symlinks so nothing outside the root is reachable', () => {
    const root = fixture();
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    writeFileSync(join(outside, 'secret.md'), '# secret');
    symlinkSync(join(outside, 'secret.md'), join(root, 'link.md'));
    symlinkSync(outside, join(root, 'dir'));
    const catalog = new FsGuideCatalog(root);
    expect(catalog.paths()).toEqual(['a.md', 'adr/b.md']);
    expect(catalog.read('link.md')).toBeUndefined();
  });

  it('only knows files present at startup', () => {
    const root = fixture();
    const catalog = new FsGuideCatalog(root);
    writeFileSync(join(root, 'late.md'), '# late');
    expect(catalog.read('late.md')).toBeUndefined();
  });
});
