import MarkdownIt from 'markdown-it';
import type { GuideLink } from '../domain/guide-links.js';
import type { MarkdownRenderer } from '../application/ports/markdown-renderer.port.js';

type Resolve = (href: string) => GuideLink;

function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-');
}

/**
 * markdown-it with raw HTML disabled (it is escaped as text). Links are resolved through the
 * caller's function: unresolvable ones become a `<span>`; images become their alt text, since the
 * page loads no external resources. Headings get GitHub-style ids so `#anchors` keep working.
 */
export class MarkdownItRenderer implements MarkdownRenderer {
  private readonly md = new MarkdownIt({ html: false, linkify: false, typographer: false });

  constructor() {
    this.md.core.ruler.push('guide_links', (state) => {
      const resolve = (state.env as { resolve: Resolve }).resolve;
      for (const block of state.tokens) {
        if (block.type !== 'inline' || !block.children) continue;
        const stack: GuideLink[] = [];
        for (const token of block.children) {
          if (token.type === 'image') {
            token.type = 'text';
            token.children = null;
          } else if (token.type === 'link_open') {
            const link = resolve(token.attrGet('href') ?? '');
            stack.push(link);
            if (link.kind === 'plain') {
              token.tag = 'span';
              token.attrs = null;
            } else if (link.kind === 'external') {
              token.attrs = [
                ['href', link.href],
                ['rel', 'noopener noreferrer'],
              ];
            } else {
              token.attrs = [['href', link.href]];
            }
          } else if (token.type === 'link_close') {
            if (stack.pop()?.kind === 'plain') token.tag = 'span';
          }
        }
      }
    });
    this.md.core.ruler.push('heading_ids', (state) => {
      const used = new Map<string, number>();
      state.tokens.forEach((token, index) => {
        if (token.type !== 'heading_open') return;
        const base = slugify(state.tokens[index + 1]?.content ?? '') || 'section';
        const count = used.get(base) ?? 0;
        used.set(base, count + 1);
        token.attrSet('id', count === 0 ? base : `${base}-${String(count)}`);
      });
    });
  }

  render(source: string, resolveLink: Resolve): string {
    return this.md.render(source, { resolve: resolveLink });
  }
}
