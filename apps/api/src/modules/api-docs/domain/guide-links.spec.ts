import { describe, expect, it } from 'vitest';
import { extractTitle, resolveGuideLink } from './guide-links.js';

const known = new Set([
  'prd/prd.md',
  'adr/0001-x.md',
  'adr/README.md',
  'configuracion.md',
  'referencia/README.md',
]);
const resolve = (from: string, href: string) => resolveGuideLink(from, href, known);

describe('resolveGuideLink', () => {
  it('keeps in-page anchors', () => {
    expect(resolve('prd/prd.md', '#alcance')).toEqual({ kind: 'anchor', href: '#alcance' });
  });

  it('rewrites a sibling .md link and keeps its anchor', () => {
    expect(resolve('adr/README.md', '0001-x.md#estado')).toEqual({
      kind: 'guide',
      href: '/docs/guides/adr/0001-x.md#estado',
    });
  });

  it('resolves parent-relative links against the current folder', () => {
    expect(resolve('adr/0001-x.md', '../configuracion.md')).toEqual({
      kind: 'guide',
      href: '/docs/guides/configuracion.md',
    });
    expect(resolve('configuracion.md', './prd/prd.md')).toMatchObject({ kind: 'guide' });
  });

  it('renders as plain text a .md link that is not in the allowlist', () => {
    expect(resolve('configuracion.md', 'nope.md')).toEqual({ kind: 'plain' });
  });

  it('renders as plain text links to non-md files and to paths outside the docs root', () => {
    expect(resolve('configuracion.md', 'referencia/guia.pdf')).toEqual({ kind: 'plain' });
    expect(resolve('configuracion.md', '../apps/api/src/main.ts')).toEqual({ kind: 'plain' });
    expect(resolve('configuracion.md', '../../etc/passwd')).toEqual({ kind: 'plain' });
    expect(resolve('configuracion.md', '/etc/passwd')).toEqual({ kind: 'plain' });
  });

  it('keeps http(s) and mailto links external and drops other schemes', () => {
    expect(resolve('configuracion.md', 'https://example.com/a')).toEqual({
      kind: 'external',
      href: 'https://example.com/a',
    });
    expect(resolve('configuracion.md', 'mailto:a@b.com')).toMatchObject({ kind: 'external' });
    expect(resolve('configuracion.md', 'javascript:alert(1)')).toEqual({ kind: 'plain' });
    expect(resolve('configuracion.md', '//evil.example/x')).toEqual({ kind: 'plain' });
  });

  it('survives malformed percent-encoding', () => {
    expect(resolve('configuracion.md', '%E0%A4%A.md')).toEqual({ kind: 'plain' });
  });
});

describe('extractTitle', () => {
  it('takes the first level-1 heading', () => {
    expect(extractTitle('intro\n\n# Mi título\n\n## Otro', 'x.md')).toBe('Mi título');
  });

  it('ignores # lines inside fenced code', () => {
    expect(extractTitle('```bash\n# comentario\n```\n# Real', 'x.md')).toBe('Real');
  });

  it('falls back to the file name', () => {
    expect(extractTitle('sin titulo', 'adr/0001-x.md')).toBe('adr/0001-x.md');
  });
});
