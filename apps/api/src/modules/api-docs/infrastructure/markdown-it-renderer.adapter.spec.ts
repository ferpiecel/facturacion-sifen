import { describe, expect, it } from 'vitest';
import type { GuideLink } from '../domain/guide-links.js';
import { MarkdownItRenderer } from './markdown-it-renderer.adapter.js';

const renderer = new MarkdownItRenderer();
const guide = (href: string): GuideLink => ({ kind: 'guide', href: `/docs/guides/${href}` });
const render = (md: string, resolve: (href: string) => GuideLink = () => ({ kind: 'plain' })) =>
  renderer.render(md, resolve);

describe('MarkdownItRenderer', () => {
  it('escapes raw HTML instead of emitting it', () => {
    const html = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders tables, code and headings with anchor ids', () => {
    const html = render(
      '# Hola mundo\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```',
    );
    expect(html).toContain('<h1 id="hola-mundo">');
    expect(html).toContain('<table>');
    expect(html).toContain('<pre><code class="language-ts">');
  });

  it('de-duplicates heading ids', () => {
    const html = render('## Uso\n\n## Uso');
    expect(html).toContain('id="uso"');
    expect(html).toContain('id="uso-1"');
  });

  it('rewrites guide links and passes the raw href to the resolver', () => {
    const seen: string[] = [];
    const html = render('[ADR](../adr/0001.md#x)', (href) => {
      seen.push(href);
      return guide('adr/0001.md#x');
    });
    expect(seen).toEqual(['../adr/0001.md#x']);
    expect(html).toContain('<a href="/docs/guides/adr/0001.md#x">ADR</a>');
  });

  it('renders unresolvable links as plain text keeping the label', () => {
    const html = render('ver [la guía](guia.pdf) ahora');
    expect(html).toContain('ver <span>la guía</span> ahora');
    expect(html).not.toContain('href');
  });

  it('opens external links safely', () => {
    const html = render('[x](https://example.com)', (href) => ({ kind: 'external', href }));
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('turns images into their alt text', () => {
    const html = render('![logo](x.png)');
    expect(html).not.toContain('<img');
    expect(html).toContain('logo');
  });
});
