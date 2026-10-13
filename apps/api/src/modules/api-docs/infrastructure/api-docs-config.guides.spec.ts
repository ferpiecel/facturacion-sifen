import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveGuidesRoot } from './api-docs-config.js';

describe('resolveGuidesRoot', () => {
  it('prefers API_DOCS_GUIDES_DIR, resolved against the cwd', () => {
    expect(resolveGuidesRoot({ API_DOCS_GUIDES_DIR: '/srv/docs' }, '/app')).toBe('/srv/docs');
    expect(resolveGuidesRoot({ API_DOCS_GUIDES_DIR: 'guides' }, '/app')).toBe('/app/guides');
  });

  it('defaults to docs/ at the workspace root found walking up from the cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), '');
    mkdirSync(join(root, 'apps', 'api'), { recursive: true });
    expect(resolveGuidesRoot({}, join(root, 'apps', 'api'))).toBe(join(root, 'docs'));
  });

  it('is undefined outside a workspace (e.g. a production image)', () => {
    expect(resolveGuidesRoot({}, mkdtempSync(join(tmpdir(), 'nows-')))).toBeUndefined();
  });
});
