'use strict';

// UI-06: renders docs/user-guide.md to the STATIC HTML page the in-app Help window loads
// (src/renderer/help/help.html). Runs at build time only (scripts/build-help.js); nothing in the app
// parses markdown at runtime.
//
// Deliberately a tiny, dependency-free converter for exactly the markdown subset the guide uses
// (headings, paragraphs, nested bullet lists, tables, **bold**, *italic*, `code`, [text](url)). Every
// piece of text is HTML-escaped; the only attributes ever emitted are heading ids and link hrefs, and
// a link is emitted only for http(s)/mailto/#anchor targets (anything else is rendered as plain
// text). The page carries no script and a strict CSP.

/**
 * UI-05 (smart copy) has shipped, so its guide section (the "Quick copy with the mouse" part, between the
 * UI-05 markers in docs/user-guide.md) is published on the Help page. Set this to `false` to leave it out and run
 * `node scripts/build-help.js` (the drift test fails until the checked-in HTML is regenerated).
 */
const PUBLISH_UI05 = true;

const UI05_START = '<!-- UI-05: publish when shipped -->';
const UI05_END = '<!-- /UI-05 -->';

const CSP =
  "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'";

const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Named unpublished sections: text between `<!-- unpublished: NAME -->` and `<!-- /unpublished: NAME -->`
 * (each marker on its own line) is left out of the Help page unless NAME is `true` here, because it describes
 * behaviour that has not shipped. Flip the flag when the feature ships, then run `node scripts/build-help.js`.
 * A NAME that is not listed counts as OFF (fail closed).
 */
const PUBLISH_FLAGS = { SSO: true };

const UNPUBLISHED_RE = /^[ \t]*<!-- unpublished: ([A-Za-z0-9_-]+) -->[ \t]*\n([\s\S]*?)^[ \t]*<!-- \/unpublished: \1 -->[ \t]*(?:\n|$)/gm;

function applyUnpublished(text, flags) {
  return text.replace(UNPUBLISHED_RE, (_m, name, body) => (flags[name] === true ? body : ''));
}

/** Remove (or, when published, just unwrap) the UI-05 and named unpublished sections; then drop any other HTML comment line. */
function applyUi05(markdown, publishUi05, flags = PUBLISH_FLAGS) {
  let text = applyUnpublished(markdown.replace(/\r\n/g, '\n'), flags);
  const start = text.indexOf(UI05_START);
  const end = text.indexOf(UI05_END);
  if (start !== -1 && end !== -1 && end > start) {
    const after = end + UI05_END.length;
    text = publishUi05
      ? text.slice(0, start) + text.slice(start + UI05_START.length, end) + text.slice(after)
      : text.slice(0, start) + text.slice(after);
  }
  return text.replace(/^[ \t]*<!--.*?-->[ \t]*\n/gm, '');
}

const SAFE_HREF = /^(https?:\/\/|mailto:|#)/i;

/** Inline markup -> HTML. Code spans first (their content is never interpreted), then links/bold/italic. */
function inline(text) {
  let out = '';
  const parts = text.split(/(`[^`]+`)/);
  for (const part of parts) {
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      out += `<code>${escapeHtml(part.slice(1, -1))}</code>`;
    } else {
      out += inlineEmphasis(part);
    }
  }
  return out;
}

function inlineEmphasis(text) {
  const token = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*(.+?)\*\*|\*(.+?)\*/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = token.exec(text)) !== null) {
    out += escapeHtml(text.slice(last, m.index));
    if (m[1] !== undefined) {
      const label = inline(m[1]);
      out += SAFE_HREF.test(m[2])
        ? `<a href="${escapeHtml(m[2])}">${label}</a>`
        : label;
    } else if (m[3] !== undefined) {
      out += `<strong>${inline(m[3])}</strong>`;
    } else {
      out += `<em>${inline(m[4])}</em>`;
    }
    last = m.index + m[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

function slugify(text, used) {
  const base =
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section';
  let slug = base;
  for (let i = 2; used.has(slug); i += 1) slug = `${base}-${i}`;
  used.add(slug);
  return slug;
}

/** Plain text of an inline-markup string (for heading ids and the contents list). */
const plain = (s) => s.replace(/`([^`]+)`/g, '$1').replace(/\*\*(.+?)\*\*|\*(.+?)\*/g, (_m, a, b) => a || b);

function splitRow(line) {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());
}

function renderList(items) {
  // items: [{ indent, text }]; nesting follows indentation (the guide nests one level, any depth works).
  let html = '';
  const stack = [];
  for (const item of items) {
    while (stack.length && item.indent < stack[stack.length - 1]) {
      html += '</li></ul>';
      stack.pop();
    }
    if (!stack.length || item.indent > stack[stack.length - 1]) {
      html += '<ul>';
      stack.push(item.indent);
    } else {
      html += '</li>';
    }
    html += `<li>${inline(item.text)}`;
  }
  while (stack.length) {
    html += '</li></ul>';
    stack.pop();
  }
  return html;
}

function renderBody(markdown) {
  const lines = markdown.split('\n');
  const used = new Set();
  const headings = [];
  let html = '';
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const text = h[2].trim();
      const id = slugify(plain(text), used);
      if (level === 2) headings.push({ id, text: plain(text) });
      html += `<h${level} id="${id}">${inline(text)}</h${level}>\n`;
      i += 1;
      continue;
    }

    if (/^\s*\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(lines[i]);
        i += 1;
      }
      const [head, , ...body] = rows; // rows[1] is the |---|---| separator
      html += '<div class="table-wrap"><table><thead><tr>';
      html += splitRow(head).map((c) => `<th>${inline(c)}</th>`).join('');
      html += '</tr></thead><tbody>';
      for (const r of body) {
        html += `<tr>${splitRow(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`;
      }
      html += '</tbody></table></div>\n';
      continue;
    }

    if (/^\s*-\s+/.test(line)) {
      const items = [];
      while (i < lines.length && lines[i].trim() !== '') {
        const b = /^(\s*)-\s+(.*)$/.exec(lines[i]);
        if (b) {
          items.push({ indent: b[1].length, text: b[2].trim() });
        } else if (items.length) {
          items[items.length - 1].text += ` ${lines[i].trim()}`; // wrapped continuation line
        } else {
          break;
        }
        i += 1;
      }
      html += `${renderList(items)}\n`;
      continue;
    }

    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^#{1,3}\s/.test(lines[i]) &&
      !/^\s*\|/.test(lines[i]) &&
      !/^\s*-\s+/.test(lines[i])
    ) {
      para.push(lines[i].trim());
      i += 1;
    }
    html += `<p>${inline(para.join(' '))}</p>\n`;
  }

  return { html, headings };
}

/** renderGuideHtml(markdown, { publishUi05 }) -> the complete, self-contained HTML document. */
function renderGuideHtml(markdown, { publishUi05 = PUBLISH_UI05, publish = {} } = {}) {
  const { html, headings } = renderBody(applyUi05(markdown, publishUi05, { ...PUBLISH_FLAGS, ...publish }));
  const toc = headings.length
    ? `<nav aria-label="Contents"><h2 class="toc-title">Contents</h2><ul>${headings
        .map((h) => `<li><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`)
        .join('')}</ul></nav>\n`
    : '';
  // The contents list goes right after the h1 line.
  const withToc = toc ? html.replace(/(<h1 [^>]*>.*?<\/h1>\n)/, `$1${toc}`) : html;
  const titleMatch = /<h1 [^>]*>(.*?)<\/h1>/.exec(html);
  const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '') : 'Help';

  return `<!DOCTYPE html>
<!-- Generated by scripts/build-help.js from docs/user-guide.md. Do not edit by hand. -->
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${CSP}" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<link rel="stylesheet" href="help.css" />
</head>
<body>
<main>
${withToc}</main>
</body>
</html>
`;
}

module.exports = { renderGuideHtml, applyUi05, applyUnpublished, PUBLISH_FLAGS, PUBLISH_UI05, UI05_START, UI05_END, CSP };
