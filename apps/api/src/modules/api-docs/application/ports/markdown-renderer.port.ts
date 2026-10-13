import type { GuideLink } from '../../domain/guide-links.js';

/** Renders Markdown to an HTML fragment. Raw HTML in the source must come out escaped. */
export interface MarkdownRenderer {
  render(source: string, resolveLink: (href: string) => GuideLink): string;
}
