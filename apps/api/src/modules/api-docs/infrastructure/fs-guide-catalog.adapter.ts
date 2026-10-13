import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GuideCatalog } from '../application/ports/guide-catalog.port.js';

/**
 * Allowlist of `**\/*.md` under a docs root, built once in the constructor. `read` only serves
 * paths that are keys of that map and never joins caller input to the filesystem, so traversal is
 * impossible by construction. Symlinks are skipped. A missing or unset root yields an empty catalog.
 */
export class FsGuideCatalog implements GuideCatalog {
  private readonly files = new Map<string, string>();

  constructor(root: string | undefined) {
    if (root) this.scan(root, '');
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  read(path: string): string | undefined {
    const absolute = this.files.get(path);
    if (absolute === undefined) return undefined;
    try {
      return readFileSync(absolute, 'utf8');
    } catch {
      return undefined;
    }
  }

  private scan(root: string, relative: string): void {
    let entries;
    try {
      entries = readdirSync(join(root, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) this.scan(root, child);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        this.files.set(child, join(root, child));
      }
    }
  }
}
