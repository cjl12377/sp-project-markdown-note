import test from 'node:test';
import assert from 'node:assert/strict';
import { marked, Marked } from 'marked';
import {
  splitFrontmatter,
  findTaskMarkers,
  toggleTask,
  createMarkdownRenderer,
  joinRoot,
  resolveRelPosix,
  obsidianOpenUri,
  findEmbedCandidates,
  searchNotes,
  suggestForProject,
  buildTree,
  parseWikilink,
  isSafeHref,
  renderRawHtml,
} from '../src/core.js';

const countRenderedCheckboxes = (src) =>
  (marked.parse(splitFrontmatter(src).body, { gfm: true }).match(/type="checkbox"/g) || []).length;

test('frontmatter is split only at the start', () => {
  const src = '---\ntags: [a]\n---\n# Title\n---\nnot fm\n';
  const r = splitFrontmatter(src);
  assert.equal(r.frontmatter, '---\ntags: [a]\n---\n');
  assert.equal(r.body, '# Title\n---\nnot fm\n');
  assert.equal(splitFrontmatter('# no fm').frontmatter, '');
});

test('task markers skip frontmatter and fenced code and match marked order', () => {
  const src = [
    '---',
    'x: - [ ] not a task',
    '---',
    '- [ ] one',
    '  - [x] two nested',
    '```',
    '- [ ] in code',
    '```',
    '1. [X] three ordered',
    '> - [ ] four quoted',
    '~~~md',
    '- [ ] tilde code',
    '~~~',
    '* [ ] five',
    '- [] not a task',
    '- [ ]tight not a task',
  ].join('\n');
  const marks = findTaskMarkers(src);
  assert.deepEqual(
    marks.map((m) => m.checked),
    [false, true, true, false, false],
  );
  for (const m of marks) assert.match(src[m.index], /[ xX]/);
  assert.equal(marks.length, countRenderedCheckboxes(src));
});

test('toggleTask flips exactly one marker', () => {
  const src = '- [ ] a\n- [x] b\n';
  assert.equal(toggleTask(src, 0), '- [x] a\n- [x] b\n');
  assert.equal(toggleTask(src, 1), '- [ ] a\n- [ ] b\n');
  assert.equal(toggleTask(src, 1, true), src);
  assert.equal(toggleTask(src, 5), src);
});

test('renderer: wikilinks, embeds, local images, frontmatter hidden', () => {
  const render = createMarkdownRenderer(Marked);
  const html = render(
    '---\ntitle: x\n---\nSee [[Projects/Alpha|Alpha]] and [[Beta#Plan]].\n\n![[diagram.png|300]]\n\n![[Other note]]\n\n![alt](img/a%20b.png)\n\n![r](https://e.com/x.png)\n\n`[[not a link]]`',
  );
  assert.ok(!html.includes('title: x'));
  assert.match(html, /<a href="#" class="wikilink" data-wikilink="Projects\/Alpha">Alpha<\/a>/);
  assert.match(html, /data-wikilink="Beta">Beta#Plan</);
  assert.match(html, /<img class="mn-img" data-embed="diagram.png" alt="diagram.png" width="300">/);
  assert.match(html, /<span class="mn-embed" data-embed-note="Other note" data-embed-anchor="">/);
  assert.match(html, /data-local="img\/a%20b.png"/);
  assert.match(html, /<img src="https:\/\/e.com\/x.png"/);
  assert.match(html, /<code>\[\[not a link\]\]<\/code>/);
});

test('renderer escapes wikilink content', () => {
  const html = createMarkdownRenderer(Marked)('[[<img src=x onerror=alert(1)>]]');
  assert.ok(!html.includes('<img src=x'));
});

test('soft line breaks render like Obsidian', () => {
  assert.match(createMarkdownRenderer(Marked)('a\nb'), /a<br>b/);
});

test('parseWikilink', () => {
  assert.deepEqual(parseWikilink('A/B#H|alias'), { target: 'A/B', anchor: 'H', alias: 'alias' });
});

test('path helpers', () => {
  assert.equal(joinRoot('/Users/me/Vault/', 'Projects/A.md', '/'), '/Users/me/Vault/Projects/A.md');
  assert.equal(joinRoot('C:\\Vault', 'Projects/A.md', '\\'), 'C:\\Vault\\Projects\\A.md');
  assert.equal(resolveRelPosix('Projects/A.md', '../Areas/B.md'), 'Areas/B.md');
  assert.equal(resolveRelPosix('A.md', '../x.md'), null);
  assert.equal(
    obsidianOpenUri({ vault: 'My Vault', rel: 'Projects/A b.md' }),
    'obsidian://open?vault=My%20Vault&file=Projects%2FA%20b',
  );
  assert.equal(obsidianOpenUri({ abs: '/x/y.md' }), 'obsidian://open?path=%2Fx%2Fy.md');
});

test('embed candidates prefer exact, then suffix, then basename', () => {
  const imgs = ['a/pic.png', 'b/pic.png', 'attachments/x/diag.png'];
  assert.deepEqual(findEmbedCandidates(imgs, 'b/pic.png'), ['b/pic.png']);
  assert.deepEqual(findEmbedCandidates(imgs, 'x/diag.png'), ['attachments/x/diag.png']);
  assert.deepEqual(findEmbedCandidates(imgs, 'pic.png'), ['a/pic.png', 'b/pic.png']);
});

test('search and suggestions', () => {
  const md = ['Projects/Alpha.md', 'Archive/Alpha old.md', 'Notes/alphabet soup.md', 'Beta.md'];
  assert.equal(searchNotes(md, 'alpha')[0], 'Projects/Alpha.md');
  assert.deepEqual(searchNotes(md, 'proj alp'), ['Projects/Alpha.md']);
  assert.deepEqual(suggestForProject(md, 'alpha'), ['Projects/Alpha.md']);
  const tree = buildTree(md);
  assert.deepEqual([...tree.dirs.keys()].sort(), ['Archive', 'Notes', 'Projects']);
  assert.deepEqual(tree.files, ['Beta.md']);
});

test('raw HTML is escaped except simple formatting tags', () => {
  const render = createMarkdownRenderer(Marked);
  const html = render('<img src=x onerror="alert(1)">\n\n<script>alert(1)</script>\n\nText <u>under</u> <mark>hi</mark> <span style="x">s</span><br>\n\n<!-- hidden -->a < b & c');
  assert.ok(!/<img|<script|<span/i.test(html), html);
  assert.match(html, /&lt;img src=x onerror=/);
  assert.match(html, /<u>under<\/u> <mark>hi<\/mark>/);
  assert.match(html, /<br>/);
  assert.ok(!html.includes('hidden'));
  assert.match(html, /a &lt; b &amp; c/);
  assert.equal(renderRawHtml('<b class="x">'), '&lt;b class=&quot;x&quot;&gt;');
});

test('unsafe link schemes are dropped, safe ones kept', () => {
  const render = createMarkdownRenderer(Marked);
  assert.ok(!render('[x](javascript:alert(1))').includes('href'));
  assert.ok(!render('[x](java\tscript:alert(1))').includes('href="java'));
  assert.ok(!render('<data:text/html,hi>').includes('href'));
  assert.match(render('[x](https://a.b/c)'), /href="https:\/\/a.b\/c"/);
  assert.match(render('[x](obsidian://open?vault=V)'), /href="obsidian:/);
  assert.match(render('[x](../Other%20note.md)'), /href="..\/Other%20note.md"/);
  for (const ok of ['Notes.md', '#h', '/abs', 'mailto:a@b.c']) assert.ok(isSafeHref(ok), ok);
  for (const bad of ['javascript:x', ' JavaScript:x', 'vbscript:x', 'data:text/html,x', 'java\nscript:x']) assert.ok(!isSafeHref(bad), bad);
});

test('image sources: remote http/data:image only', () => {
  const render = createMarkdownRenderer(Marked);
  assert.match(render('![a](data:image/png;base64,AAAA)'), /<img src="data:image\/png/);
  assert.ok(!render('![a](javascript:alert(1))').includes('src='));
});

import {
  findNoteCandidates,
  extractSection,
  formatDate,
  dailyNoteRel,
  fillTemplate,
  isNoteTarget,
} from '../src/core.js';

test('callouts: plain, foldable, nested content, tasks stay aligned', () => {
  const render = createMarkdownRenderer(Marked);
  const src = '> [!tip] Remember\n> Body **bold**\n> - [ ] inside\n\n> [!bug]- Folded\n> hidden\n\n> plain quote\n\n- [x] outside';
  const html = render(src);
  assert.match(html, /<div class="callout callout-teal" data-callout="tip"><div class="callout-title"><span class="callout-icon">✦<\/span>Remember<\/div>/);
  assert.match(html, /<details class="callout callout-red" data-callout="bug"><summary/);
  assert.match(html, /<blockquote>\s*<p>plain quote/);
  assert.equal((html.match(/type="checkbox"/g) || []).length, findTaskMarkers(src).length);
  assert.match(render('> [!NOTE]\n> x'), /callout-blue" data-callout="note"><div class="callout-title"><span class="callout-icon">ℹ<\/span>Note/);
});

test('tags: words only, not headings, numbers, code, urls or C#', () => {
  const render = createMarkdownRenderer(Marked);
  const html = render('# Heading\n\nA #tag, #nested/tag and #2026 C# `#code` https://a.b/#frag (#paren)');
  assert.match(html, /data-tag="tag">#tag</);
  assert.match(html, /data-tag="nested\/tag"/);
  assert.match(html, /data-tag="paren"/);
  assert.ok(!/data-tag="2026"/.test(html));
  assert.ok(!/data-tag="code"/.test(html));
  assert.ok(!/data-tag="frag"/.test(html));
  assert.match(html, /<h1>Heading<\/h1>/);
});

test('embed targets', () => {
  assert.ok(isNoteTarget('Note'));
  assert.ok(isNoteTarget('Folder/Note.md'));
  assert.ok(!isNoteTarget('doc.pdf'));
  const md = ['Projects/Plan.md', 'Archive/Plan.md', 'Areas/Deep/Plan.md', 'Notes/Other.md'];
  assert.deepEqual(findNoteCandidates(md, 'Plan', 'Archive/x.md')[0], 'Archive/Plan.md');
  assert.deepEqual(findNoteCandidates(md, 'Plan', 'Notes/x.md')[0], 'Archive/Plan.md'.length <= 'Projects/Plan.md'.length ? 'Archive/Plan.md' : 'Projects/Plan.md');
  assert.deepEqual(findNoteCandidates(md, 'Deep/Plan'), ['Areas/Deep/Plan.md']);
  assert.deepEqual(findNoteCandidates(md, 'projects/plan.md'), ['Projects/Plan.md']);
  assert.deepEqual(findNoteCandidates(md, 'Missing'), []);
});

test('extractSection: whole note, heading, nested headings, block ids', () => {
  const src = '---\na: 1\n---\n# Top\nintro\n## Plan\nstep 1\n### Sub\ndetail\n## Next\nlater\n\npara line 1\npara line 2 ^p1\n\n- item a\n- item b ^b2\n```\n## Not a heading\n```';
  assert.ok(!extractSection(src, '').includes('a: 1'));
  assert.equal(extractSection(src, 'Plan'), '## Plan\nstep 1\n### Sub\ndetail');
  assert.equal(extractSection(src, 'Top#Plan'), '## Plan\nstep 1\n### Sub\ndetail');
  assert.equal(extractSection(src, '^p1'), 'para line 1\npara line 2');
  assert.equal(extractSection(src, '^b2'), '- item b');
  assert.equal(extractSection(src, 'Nope'), null);
  assert.equal(extractSection(src, '^zz'), null);
});

test('daily note paths and templates', () => {
  const d = new Date(2026, 0, 4, 9, 5);
  assert.equal(formatDate(d, 'YYYY-MM-DD'), '2026-01-04');
  assert.equal(formatDate(d, 'dddd, Do MMMM YYYY'), 'Sunday, 4th January 2026');
  assert.equal(formatDate(d, 'YYYY/[W]WW/YYYY-MM-DD'), '2026/W01/2026-01-04');
  assert.equal(formatDate(new Date(2026, 11, 31), 'GGGG-[W]WW'), '2026-W53');
  assert.equal(dailyNoteRel({ folder: '/Daily/', format: 'YYYY-MM-DD' }, d), 'Daily/2026-01-04.md');
  assert.equal(dailyNoteRel({}, d), '2026-01-04.md');
  assert.equal(
    fillTemplate('# {{title}}\n{{date:dddd}} {{time}} {{ date }}', d, '2026-01-04'),
    '# 2026-01-04\nSunday 09:05 2026-01-04',
  );
});
