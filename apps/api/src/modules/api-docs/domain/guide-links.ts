import { posix } from 'node:path';

/** URL prefix under which the Markdown guides are served. */
export const GUIDES_BASE_PATH = '/docs/guides';

/** What a Markdown link becomes once resolved against the guides allowlist. */
export type GuideLink =
  | { kind: 'anchor'; href: string }
  | { kind: 'guide'; href: string }
  | { kind: 'external'; href: string }
  | { kind: 'plain' };

const PLAIN: GuideLink = { kind: 'plain' };

/**
 * Resolves `href`, written in the guide `fromPath` (posix, relative to the docs root), to a link.
 * Only `.md` files in the allowlist `known` become guide links; every other relative target (PDF,
 * XSD, source code, paths escaping the docs root) is `plain`, so nothing off the allowlist is linked.
 */
export function resolveGuideLink(
  fromPath: string,
  href: string,
  known: ReadonlySet<string>,
): GuideLink {
  if (href.startsWith('#')) return { kind: 'anchor', href };
  if (href.startsWith('//')) return PLAIN;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();
  if (scheme) {
    return scheme === 'http' || scheme === 'https' || scheme === 'mailto'
      ? { kind: 'external', href }
      : PLAIN;
  }
  const hashAt = href.indexOf('#');
  const hash = hashAt >= 0 ? href.slice(hashAt) : '';
  const pathPart = (hashAt >= 0 ? href.slice(0, hashAt) : href).split('?')[0];
  if (!pathPart || pathPart.startsWith('/')) return PLAIN;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    return PLAIN;
  }
  const target = posix.normalize(posix.join(posix.dirname(fromPath), decoded));
  if (target.startsWith('..') || !known.has(target)) return PLAIN;
  return { kind: 'guide', href: `${GUIDES_BASE_PATH}/${encodeURI(target)}${hash}` };
}

/** Title of a guide: its first level-1 heading outside fenced code, else `fallback`. */
export function extractTitle(source: string, fallback: string): string {
  let fence: string | undefined;
  for (const line of source.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
      continue;
    }
    if (fence) continue;
    const heading = /^#\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
    if (heading) return heading;
  }
  return fallback;
}
