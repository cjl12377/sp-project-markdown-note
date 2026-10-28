// Pure helpers: no DOM, no PluginAPI. Unit-tested in test/core.test.mjs.

export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

const FRONTMATTER_RE = /^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/** Split a leading YAML frontmatter block from the body. */
export const splitFrontmatter = (src) => {
  const m = FRONTMATTER_RE.exec(src);
  if (!m) return { frontmatter: '', body: src };
  return { frontmatter: m[0], body: src.slice(m[0].length) };
};

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const TASK_RE = /^((?:[ \t]*>[ \t]?)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)\[([ xX])\](?=[ \t]|$)/;

/**
 * Find GFM task-list markers in document order, skipping frontmatter and
 * fenced code. Order matches the checkboxes marked renders in the preview.
 * Returns absolute character offsets of the mark character inside `[ ]`.
 */
export const findTaskMarkers = (src) => {
  const { frontmatter } = splitFrontmatter(src);
  const markers = [];
  let offset = frontmatter.length;
  const lines = src.slice(offset).split('\n');
  let fence = null;
  for (const line of lines) {
    const f = FENCE_RE.exec(line.replace(/^(?:[ \t]*>[ \t]?)+/, ''));
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
    } else if (f) {
      fence = f[1];
    } else {
      const m = TASK_RE.exec(line);
      if (m) markers.push({ index: offset + m[1].length + 1, checked: m[2] !== ' ' });
    }
    offset += line.length + 1;
  }
  return markers;
};

/** Toggle the n-th task checkbox; returns the new source (unchanged if n is out of range). */
export const toggleTask = (src, n, checked) => {
  const markers = findTaskMarkers(src);
  const mk = markers[n];
  if (!mk) return src;
  const next = typeof checked === 'boolean' ? checked : !mk.checked;
  return src.slice(0, mk.index) + (next ? 'x' : ' ') + src.slice(mk.index + 1);
};

export const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Parse the inside of [[...]] into target, heading anchor and display text. */
export const parseWikilink = (inner) => {
  const bar = inner.indexOf('|');
  const ref = (bar === -1 ? inner : inner.slice(0, bar)).trim();
  const alias = bar === -1 ? '' : inner.slice(bar + 1).trim();
  const hash = ref.indexOf('#');
  const target = (hash === -1 ? ref : ref.slice(0, hash)).trim();
  const anchor = hash === -1 ? '' : ref.slice(hash + 1).trim();
  return { target, anchor, alias };
};

const wikilinkExtension = {
  name: 'wikilink',
  level: 'inline',
  start(src) {
    const m = /!?\[\[/.exec(src);
    return m ? m.index : undefined;
  },
  tokenizer(src) {
    const m = /^(!?)\[\[([^[\]\n]+?)\]\]/.exec(src);
    if (!m) return undefined;
    return { type: 'wikilink', raw: m[0], embed: m[1] === '!', ...parseWikilink(m[2]) };
  },
  renderer(tok) {
    const label = tok.alias || (tok.anchor ? `${tok.target}#${tok.anchor}` : tok.target);
    if (tok.embed && IMAGE_EXT_RE.test(tok.target)) {
      const width = /^\d+(x\d+)?$/.test(tok.alias) ? tok.alias.split('x')[0] : '';
      return `<img class="mn-img" data-embed="${escapeHtml(tok.target)}" alt="${escapeHtml(tok.target)}"${
        width ? ` width="${width}"` : ''
      }>`;
    }
    if (tok.embed && isNoteTarget(tok.target)) {
      // Filled in by the app (it needs file access); see renderEmbeds in app.js.
      return `<span class="mn-embed" data-embed-note="${escapeHtml(tok.target)}" data-embed-anchor="${escapeHtml(
        tok.anchor,
      )}"><a href="#" class="mn-embed-title wikilink" data-wikilink="${escapeHtml(tok.target)}">${escapeHtml(
        label || 'This note',
      )}</a><span class="mn-embed-body"><span class="hint">Loading…</span></span></span>`;
    }
    const cls = tok.embed ? 'wikilink wikilink-embed' : 'wikilink';
    const text = tok.embed ? `↪ ${label}` : label;
    return `<a href="#" class="${cls}" data-wikilink="${escapeHtml(tok.target || '')}">${escapeHtml(text)}</a>`;
  },
};

/** True for embed targets that are notes (no extension, or .md). */
export const isNoteTarget = (target) => !/\.[a-z0-9]{1,5}$/i.test(target) || /\.md$/i.test(target);

// ---------- Obsidian callouts:  > [!type]+/- Title ----------

const CALLOUT_GROUPS = {
  note: 'blue', info: 'blue', todo: 'blue',
  abstract: 'teal', summary: 'teal', tldr: 'teal', tip: 'teal', hint: 'teal', important: 'teal',
  success: 'green', check: 'green', done: 'green',
  question: 'orange', help: 'orange', faq: 'orange', warning: 'orange', caution: 'orange', attention: 'orange',
  failure: 'red', fail: 'red', missing: 'red', danger: 'red', error: 'red', bug: 'red',
  example: 'purple',
  quote: 'grey', cite: 'grey',
};
const CALLOUT_ICONS = {
  blue: 'ℹ', teal: '✦', green: '✓', orange: '⚠', red: '✗', purple: '☰', grey: '❝',
};
export const calloutGroup = (kind) => CALLOUT_GROUPS[kind] || 'blue';

const CALLOUT_RE = /^( {0,3}> ?\[!([A-Za-z0-9_-]+)\]([+-]?)[ \t]*([^\n]*)(?:\n|$))((?: {0,3}>[^\n]*(?:\n|$))*)/;

const calloutExtension = {
  name: 'callout',
  level: 'block',
  start(src) {
    const m = /(?:^|\n) {0,3}> ?\[!/.exec(src);
    if (!m) return undefined;
    return src[m.index] === '\n' ? m.index + 1 : m.index;
  },
  tokenizer(src) {
    const m = CALLOUT_RE.exec(src);
    if (!m) return undefined;
    const kind = m[2].toLowerCase();
    const title = m[4].trim() || kind.charAt(0).toUpperCase() + kind.slice(1);
    const body = m[5].replace(/^ {0,3}> ?/gm, '');
    const token = { type: 'callout', raw: m[0], kind, fold: m[3], tokens: [], titleTokens: [] };
    this.lexer.blockTokens(body, token.tokens);
    this.lexer.inline(title, token.titleTokens);
    return token;
  },
  renderer(tok) {
    const group = calloutGroup(tok.kind);
    const head = `<span class="callout-icon">${CALLOUT_ICONS[group]}</span>${this.parser.parseInline(tok.titleTokens)}`;
    const body = this.parser.parse(tok.tokens);
    const cls = `callout callout-${group}" data-callout="${escapeHtml(tok.kind)}`;
    if (tok.fold) {
      return `<details class="${cls}"${tok.fold === '+' ? ' open' : ''}><summary class="callout-title">${head}</summary><div class="callout-content">${body}</div></details>`;
    }
    return `<div class="${cls}"><div class="callout-title">${head}</div>${body ? `<div class="callout-content">${body}</div>` : ''}</div>`;
  },
};

// ---------- #tags ----------

const TAG_CHARS = '[^\\s#.,;:!?()\\[\\]{}"\'`<>|*~=]';
const TAG_BODY_RE = new RegExp(`^#(${TAG_CHARS}*[^\\s#\\d.,;:!?()\\[\\]{}"'\`<>|*~=]${TAG_CHARS}*)`);
const TAG_START_RE = new RegExp(`(^|[\\s(])#(?=${TAG_CHARS}*[^\\s#\\d.,;:!?()\\[\\]{}"'\`<>|*~=])`);

const tagExtension = {
  name: 'tag',
  level: 'inline',
  start(src) {
    const m = TAG_START_RE.exec(src);
    return m ? m.index + m[1].length : undefined;
  },
  tokenizer(src) {
    const m = TAG_BODY_RE.exec(src);
    if (!m) return undefined;
    return { type: 'tag', raw: m[0], tag: m[1] };
  },
  renderer(tok) {
    return `<a href="#" class="tag" data-tag="${escapeHtml(tok.tag)}">#${escapeHtml(tok.tag)}</a>`;
  },
};

// ---------- ==highlights== ----------

const highlightExtension = {
  name: 'highlight',
  level: 'inline',
  start(src) {
    const i = src.indexOf('==');
    return i === -1 ? undefined : i;
  },
  tokenizer(src) {
    const m = /^==(?=[^\s=])((?:[^\n=]|=(?!=))*?[^\s=])==(?!=)/.exec(src);
    if (!m) return undefined;
    return { type: 'highlight', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
  },
  renderer(tok) {
    return `<mark>${this.parser.parseInline(tok.tokens)}</mark>`;
  },
};

const isRemoteSrc =(href) => /^(https?:|data:image\/)/i.test(href);

// Raw HTML in notes is shown as text, except a few attribute-less formatting
// tags. Together with the link check below this makes the preview safe without
// a sanitiser library (index.html must stay under 100 KB on released hosts).
const SAFE_TAG_RE = /&lt;(\/?)(br|u|mark|sub|sup|kbd|b|i|s|em|strong|del|ins|small)\s*\/?&gt;/gi;
export const renderRawHtml = (raw) =>
  escapeHtml(String(raw).replace(/<!--[\s\S]*?-->/g, '')).replace(SAFE_TAG_RE, (_m, close, tag) =>
    `<${close}${tag.toLowerCase()}>`,
  );

const SAFE_LINK_RE = /^(?:https?:|mailto:|tel:|obsidian:|zotero:|file:|#|[^a-z]|[a-z0-9+.-]+(?:[^a-z0-9+.:-]|$))/i;
export const isSafeHref = (href) => SAFE_LINK_RE.test(String(href).replace(/[\u0000-\u0020\u007f]/g, ''));

/**
 * Build a markdown renderer that mirrors Obsidian defaults (GFM, soft breaks).
 * `Marked` is passed in: the plugin ships it in plugin.js (no size limit) so
 * index.html stays under the 100 KB cap of released Super Productivity builds.
 */
export const createMarkdownRenderer = (Marked) => {
  const md = new Marked({ gfm: true, breaks: true });
  md.use({
    extensions: [calloutExtension, wikilinkExtension, tagExtension, highlightExtension],
    renderer: {
      html({ text }) {
        return renderRawHtml(text);
      },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens);
        if (!href || !isSafeHref(href)) return inner;
        const t = title ? ` title="${escapeHtml(title)}"` : '';
        return `<a href="${escapeHtml(href)}"${t}>${inner}</a>`;
      },
      image({ href, title, text }) {
        const alt = escapeHtml(text || '');
        const t = title ? ` title="${escapeHtml(title)}"` : '';
        if (!href) return alt;
        if (isRemoteSrc(href)) return `<img src="${escapeHtml(href)}" alt="${alt}"${t}>`;
        return `<img class="mn-img" data-local="${escapeHtml(href)}" alt="${alt}"${t}>`;
      },
    },
  });
  return (src) => md.parse(splitFrontmatter(src).body, { async: false });
};

/** Join a root folder and a vault-relative posix path with the OS separator. */
export const joinRoot = (root, rel, sep) => {
  const trimmed = root.replace(/[\\/]+$/, '');
  const relNative = rel.split('/').join(sep);
  return trimmed + sep + relNative;
};

/** Resolve a relative posix path against the directory of another posix path. */
export const resolveRelPosix = (fromFile, href) => {
  const parts = fromFile.split('/');
  parts.pop();
  for (const seg of href.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
};

export const stripMdExt = (p) => p.replace(/\.md$/i, '');

export const obsidianOpenUri = ({ vault, rel, abs }) => {
  if (vault && rel) {
    return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(stripMdExt(rel))}`;
  }
  if (abs) return `obsidian://open?path=${encodeURIComponent(abs)}`;
  return null;
};

export const obsidianWikiUri = (vault, target) =>
  vault && target
    ? `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(target)}`
    : null;

const basename = (p) => p.slice(p.lastIndexOf('/') + 1);

/** Find vault images matching an Obsidian embed target (path, suffix or bare name). */
export const findEmbedCandidates = (imgPaths, target) => {
  const t = target.replace(/^\/+/, '');
  const lower = t.toLowerCase();
  const exact = imgPaths.filter((p) => p.toLowerCase() === lower);
  if (exact.length) return exact.slice(0, 3);
  const suffix = imgPaths.filter((p) => p.toLowerCase().endsWith('/' + lower));
  if (suffix.length) return suffix.slice(0, 3);
  const name = basename(lower);
  return imgPaths.filter((p) => basename(p.toLowerCase()) === name).slice(0, 3);
};

/** Rank vault notes for a search query, favouring file-name matches. */
export const searchNotes = (paths, query, limit = 200) => {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/);
  const scored = [];
  for (const p of paths) {
    const lp = p.toLowerCase();
    if (!words.every((w) => lp.includes(w))) continue;
    const name = stripMdExt(basename(lp));
    let score = 0;
    if (name === q) score += 100;
    else if (name.startsWith(q)) score += 50;
    else if (name.includes(q)) score += 25;
    score -= lp.split('/').length;
    scored.push([score, p]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));
  return scored.slice(0, limit).map((s) => s[1]);
};

/** Notes whose file name matches the project title (suggested links). */
export const suggestForProject = (paths, title, limit = 5) => {
  const t = (title || '').trim().toLowerCase();
  if (!t) return [];
  return paths.filter((p) => stripMdExt(basename(p.toLowerCase())) === t).slice(0, limit);
};

/** Build a nested folder tree from posix paths. */
export const buildTree = (paths) => {
  const root = { name: '', dirs: new Map(), files: [] };
  for (const p of paths) {
    const segs = p.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      if (!node.dirs.has(segs[i])) node.dirs.set(segs[i], { name: segs[i], dirs: new Map(), files: [] });
      node = node.dirs.get(segs[i]);
    }
    node.files.push(p);
  }
  return root;
};

export const mimeForPath = (p) => {
  const ext = (/\.([a-z0-9]+)$/i.exec(p) || [])[1]?.toLowerCase();
  return (
    {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml',
      bmp: 'image/bmp',
      avif: 'image/avif',
    }[ext] || 'application/octet-stream'
  );
};

// ---------- Embedded notes ----------

const noteBase = (p) => stripMdExt(basename(p)).toLowerCase();

/**
 * Resolve an Obsidian link target to vault-relative note paths, best first:
 * exact path, path suffix, then same file name (same folder as the current
 * note first, then the shortest path) — close to Obsidian's own rules.
 */
export const findNoteCandidates = (mdPaths, target, fromRel = '') => {
  const t = stripMdExt(target.trim().replace(/^\/+/, '')).toLowerCase();
  if (!t) return [];
  const exact = mdPaths.filter((p) => stripMdExt(p).toLowerCase() === t);
  if (exact.length) return exact;
  if (t.includes('/')) {
    const suffix = mdPaths.filter((p) => stripMdExt(p).toLowerCase().endsWith('/' + t));
    if (suffix.length) return suffix;
  }
  const name = t.slice(t.lastIndexOf('/') + 1);
  const dir = fromRel.includes('/') ? fromRel.slice(0, fromRel.lastIndexOf('/') + 1).toLowerCase() : '';
  return mdPaths
    .filter((p) => noteBase(p) === name)
    .sort((a, b) => {
      const sa = dir && a.toLowerCase().startsWith(dir) ? 0 : 1;
      const sb = dir && b.toLowerCase().startsWith(dir) ? 0 : 1;
      return sa - sb || a.split('/').length - b.split('/').length || a.localeCompare(b);
    });
};

const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t#]*$/;
const normHeading = (h) =>
  h
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/[*_`~]/g, '')
    .trim()
    .toLowerCase();

const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s/;
const isListItem = (l) => LIST_ITEM_RE.test(l);
const indentOf = (l) => l.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;

/** First line of the block that ends at line `end` (a loose list spans blank lines). */
const blockStart = (lines, end) => {
  const up = (s) => {
    while (s > 0 && lines[s - 1].trim() && !HEADING_RE.test(lines[s - 1])) s--;
    return s;
  };
  let start = up(end);
  while (start > 0 && (isListItem(lines[start]) || indentOf(lines[start]) > 0)) {
    let j = start - 1;
    while (j >= 0 && !lines[j].trim()) j--;
    if (j < 0 || j === start - 1 || HEADING_RE.test(lines[j])) break;
    if (!isListItem(lines[j]) && indentOf(lines[j]) === 0) break;
    start = up(j);
  }
  return start;
};

/** Pick the part of a note an embed points at: #Heading, #^block-id, or all of it. */
export const extractSection = (src, anchor) => {
  const body = splitFrontmatter(src).body;
  if (!anchor) return body;
  const lines = body.split('\n');
  if (anchor.startsWith('^')) {
    const esc = anchor.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const endRe = new RegExp(`\\s\\^${esc}\\s*$`);
    const ownRe = new RegExp(`^\\s*\\^${esc}\\s*$`);
    const i = lines.findIndex((l) => endRe.test(l) || ownRe.test(l));
    if (i === -1) return null;
    if (ownRe.test(lines[i])) {
      // Obsidian puts the id on its own line after a list, quote or table.
      let end = i - 1;
      while (end >= 0 && !lines[end].trim()) end--;
      if (end < 0) return null;
      return lines.slice(blockStart(lines, end), end + 1).join('\n');
    }
    if (isListItem(lines[i])) {
      // A list item brings its indented children along.
      const base = indentOf(lines[i]);
      let end = i;
      for (let k = i + 1; k < lines.length; k++) {
        if (!lines[k].trim()) continue;
        if (indentOf(lines[k]) <= base) break;
        end = k;
      }
      return [lines[i].replace(endRe, ''), ...lines.slice(i + 1, end + 1)].join('\n');
    }
    return lines
      .slice(blockStart(lines, i), i + 1)
      .join('\n')
      .replace(endRe, '');
  }
  const want = normHeading(anchor.split('#').pop());
  let fence = false;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(lines[i])) fence = !fence;
    if (fence) continue;
    const m = HEADING_RE.exec(lines[i]);
    if (!m) continue;
    if (start === -1) {
      if (normHeading(m[2]) === want) {
        start = i;
        level = m[1].length;
      }
    } else if (m[1].length <= level) {
      return lines.slice(start, i).join('\n');
    }
  }
  return start === -1 ? null : lines.slice(start).join('\n');
};

// ---------- Daily notes ----------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n, w = 2) => String(n).padStart(w, '0');

/** ISO week number and week-year. */
const isoWeek = (d) => {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  return { week: Math.ceil(((t - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7), year: y };
};

/** Format a date with the moment.js tokens Obsidian uses for daily notes. */
export const formatDate = (date, fmt = 'YYYY-MM-DD') => {
  const map = {
    YYYY: () => String(date.getFullYear()),
    YY: () => pad(date.getFullYear() % 100),
    GGGG: () => String(isoWeek(date).year),
    gggg: () => String(isoWeek(date).year),
    MMMM: () => MONTHS[date.getMonth()],
    MMM: () => MONTHS[date.getMonth()].slice(0, 3),
    MM: () => pad(date.getMonth() + 1),
    M: () => String(date.getMonth() + 1),
    Do: () => {
      const n = date.getDate();
      const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
      return n + s;
    },
    DD: () => pad(date.getDate()),
    D: () => String(date.getDate()),
    dddd: () => DAYS[date.getDay()],
    ddd: () => DAYS[date.getDay()].slice(0, 3),
    WW: () => pad(isoWeek(date).week),
    W: () => String(isoWeek(date).week),
    ww: () => pad(isoWeek(date).week),
    w: () => String(isoWeek(date).week),
    HH: () => pad(date.getHours()),
    mm: () => pad(date.getMinutes()),
    ss: () => pad(date.getSeconds()),
  };
  return fmt.replace(/\[([^\]]*)\]|YYYY|YY|GGGG|gggg|MMMM|MMM|MM|M|Do|DD|D|dddd|ddd|WW|W|ww|w|HH|mm|ss/g, (tok, lit) =>
    lit !== undefined ? lit : map[tok](),
  );
};

/** Vault-relative path of the daily note for a date. */
export const dailyNoteRel = (cfg, date) => {
  const folder = (cfg.folder || '').replace(/^\/+|\/+$/g, '');
  const name = formatDate(date, cfg.format || 'YYYY-MM-DD');
  return (folder ? folder + '/' : '') + name + '.md';
};

/** Fill Obsidian core-template variables: {{date}}, {{date:FMT}}, {{time}}, {{title}}. */
export const fillTemplate = (tpl, date, title, dateFormat = 'YYYY-MM-DD') =>
  tpl.replace(/\{\{\s*(date|time|title)(?::([^}]*))?\s*\}\}/gi, (_m, kind, fmt) => {
    const k = kind.toLowerCase();
    if (k === 'title') return title;
    if (k === 'time') return formatDate(date, fmt || 'HH:mm');
    return formatDate(date, fmt || dateFormat);
  });
