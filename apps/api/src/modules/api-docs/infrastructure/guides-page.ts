import type { GuideGroup } from '../application/guide-browser.js';
import { GUIDES_BASE_PATH } from '../domain/guide-links.js';

/** No script at all: the pages are static HTML and CSS. */
export const GUIDES_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const STYLES = `
:root{color-scheme:light dark;--fg:#1f2328;--bg:#fff;--muted:#59636e;--line:#d1d9e0;--code:#f6f8fa;--link:#0969da}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--bg:#0d1117;--muted:#9198a1;--line:#3d444d;--code:#161b22;--link:#4493f8}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
nav{display:flex;gap:1.25rem;padding:.75rem 1rem;border-bottom:1px solid var(--line);font-size:.9rem}
main{max-width:56rem;margin:0 auto;padding:1rem 1rem 4rem;overflow-wrap:anywhere}
a{color:var(--link)}h1,h2,h3{line-height:1.25}h1,h2{border-bottom:1px solid var(--line);padding-bottom:.3em}
code{background:var(--code);padding:.15em .35em;border-radius:4px;font-size:.9em}
pre{background:var(--code);padding:1rem;border-radius:6px;overflow:auto}pre code{padding:0;background:none}
table{border-collapse:collapse;display:block;overflow:auto}th,td{border:1px solid var(--line);padding:.4rem .75rem}
th{background:var(--code)}blockquote{margin:0;padding:0 1rem;color:var(--muted);border-left:.25em solid var(--line)}
ul.index{list-style:none;padding-left:0}ul.index li{padding:.2rem 0}.path{color:var(--muted);font-size:.85em;margin-left:.5rem}
`;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<nav><a href="${GUIDES_BASE_PATH}">Guías</a><a href="/docs">Referencia de la API</a></nav>
<main>
${body}
</main>
</body>
</html>
`;
}

export function renderGuidesIndex(groups: GuideGroup[]): string {
  const sections = groups
    .map((group) => {
      const items = group.guides
        .map(
          (guide) =>
            `<li><a href="${GUIDES_BASE_PATH}/${escapeHtml(encodeURI(guide.path))}">${escapeHtml(guide.title)}</a><span class="path">${escapeHtml(guide.path)}</span></li>`,
        )
        .join('\n');
      return `<h2>${escapeHtml(group.folder || 'General')}</h2>\n<ul class="index">\n${items}\n</ul>`;
    })
    .join('\n');
  const empty = groups.length === 0 ? '<p>No hay guías disponibles en este entorno.</p>' : '';
  return layout('Guías', `<h1>Guías</h1>\n${empty}${sections}`);
}

export function renderGuidePage(title: string, html: string): string {
  return layout(title, html);
}
