import { extractTitle, resolveGuideLink } from '../domain/guide-links.js';
import type { GuideCatalog } from './ports/guide-catalog.port.js';
import type { MarkdownRenderer } from './ports/markdown-renderer.port.js';

export interface GuideGroup {
  folder: string;
  guides: { path: string; title: string }[];
}

export interface GuidePage {
  path: string;
  title: string;
  html: string;
}

/** Index and rendered pages of the Markdown guides. */
export class GuideBrowser {
  private readonly known: ReadonlySet<string>;

  constructor(
    private readonly catalog: GuideCatalog,
    private readonly renderer: MarkdownRenderer,
  ) {
    this.known = new Set(catalog.paths());
  }

  /** Guides grouped by top-level folder (root files first, under the empty folder name). */
  index(): GuideGroup[] {
    const groups = new Map<string, GuideGroup>();
    for (const path of this.catalog.paths()) {
      const slash = path.indexOf('/');
      const folder = slash < 0 ? '' : path.slice(0, slash);
      const title = extractTitle(this.catalog.read(path) ?? '', path);
      const group = groups.get(folder) ?? { folder, guides: [] };
      group.guides.push({ path, title });
      groups.set(folder, group);
    }
    return [...groups.values()].sort((a, b) => a.folder.localeCompare(b.folder));
  }

  page(path: string): GuidePage | undefined {
    if (!this.known.has(path)) return undefined;
    const source = this.catalog.read(path);
    if (source === undefined) return undefined;
    return {
      path,
      title: extractTitle(source, path),
      html: this.renderer.render(source, (href) => resolveGuideLink(path, href, this.known)),
    };
  }
}
