// Runs each node script the way Super Productivity's direct executor does
// (electron/plugin-node-executor.ts: canExecuteDirectly + executeDirectly).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ALL_SCRIPTS, SCRIPT_CREATE, SCRIPT_BACKUP, SCRIPT_CHECK_ROOT, SCRIPT_RESOLVE_LINK, SCRIPT_READ, SCRIPT_STAT, SCRIPT_WRITE, SCRIPT_SCAN, SCRIPT_READ_IMAGE, SCRIPT_INFO } from '../src/node-scripts.js';

const DANGEROUS =
  /require\s*\(\s*['"`](?!fs|path|os)[^'"]+['"`]\s*\)|child_process|exec|spawn|eval|Function|process\.exit/;

const run = async (script, args = [], osImpl = os) => {
  const sandbox = {
    require: (m) => ({ fs, path, os: osImpl })[m] ?? (() => { throw new Error(`Module '${m}' is not allowed`); })(),
    console,
    JSON,
    args,
    __result: undefined,
  };
  const ctx = vm.createContext(sandbox);
  await vm.runInContext(
    `(async function() { const result = await (async function() { ${script} })(); __result = result; })()`,
    ctx,
    { timeout: 5000 },
  );
  return JSON.parse(JSON.stringify(sandbox.__result));
};

test('every script qualifies for direct (in-process) execution', () => {
  for (const [name, s] of Object.entries(ALL_SCRIPTS)) {
    assert.ok(!DANGEROUS.test(s), `${name} would be spawned`);
    assert.ok(s.length < 100000);
  }
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pmn-'));
const vault = path.join(tmp, 'My Vault');
fs.mkdirSync(path.join(vault, 'Projects', 'img'), { recursive: true });
fs.mkdirSync(path.join(vault, '.obsidian'));
fs.writeFileSync(path.join(vault, '.obsidian', 'hidden.md'), 'x');
fs.writeFileSync(path.join(vault, 'Projects', 'Alpha.md'), '# Alpha\n- [ ] a\n');
fs.writeFileSync(path.join(vault, 'Projects', 'img', 'pic.png'), Buffer.from([137, 80, 78, 71]));
fs.writeFileSync(path.join(vault, 'Projects', 'notpng.txt'), 'x');
fs.writeFileSync(path.join(tmp, 'outside.md'), 'outside');
fs.symlinkSync(path.join(vault, 'Projects', 'Alpha.md'), path.join(vault, 'Link.md'));

test('info', async () => {
  const r = await run(SCRIPT_INFO);
  assert.equal(r.sep, path.sep);
  assert.ok(r.host);
});

test('check root', async () => {
  assert.deepEqual(await run(SCRIPT_CHECK_ROOT, [vault + '/']), { abs: vault, name: 'My Vault' });
  assert.match((await run(SCRIPT_CHECK_ROOT, ['relative/x'])).error, /full path/);
  assert.match((await run(SCRIPT_CHECK_ROOT, [path.join(vault, 'nope')])).error, /not found/);
  assert.match((await run(SCRIPT_CHECK_ROOT, [path.join(vault, 'Link.md')])).error, /Not a folder/);
});

test('resolve link: inside root, relative, outside, quoted, file URL, bad type', async () => {
  const alpha = path.join(vault, 'Projects', 'Alpha.md');
  assert.deepEqual(await run(SCRIPT_RESOLVE_LINK, [vault, alpha]), { abs: alpha, rel: 'Projects/Alpha.md' });
  assert.deepEqual(await run(SCRIPT_RESOLVE_LINK, [vault, 'Projects/Alpha.md']), { abs: alpha, rel: 'Projects/Alpha.md' });
  assert.deepEqual(await run(SCRIPT_RESOLVE_LINK, [vault, `"${alpha}"`]), { abs: alpha, rel: 'Projects/Alpha.md' });
  assert.deepEqual(await run(SCRIPT_RESOLVE_LINK, [vault, 'file://' + encodeURI(alpha)]), { abs: alpha, rel: 'Projects/Alpha.md' });
  const out = path.join(tmp, 'outside.md');
  assert.deepEqual(await run(SCRIPT_RESOLVE_LINK, [vault, out]), { abs: out, rel: null });
  assert.deepEqual(await run(SCRIPT_RESOLVE_LINK, [null, out]), { abs: out, rel: null });
  assert.match((await run(SCRIPT_RESOLVE_LINK, [null, 'x.md'])).error, /full path/);
  assert.match((await run(SCRIPT_RESOLVE_LINK, [vault, path.join(vault, 'Projects', 'notpng.txt')])).error, /\.md/);
  assert.match((await run(SCRIPT_RESOLVE_LINK, [vault, path.join(vault, 'Nope.md')])).error, /not found/);
});

test('read, stat, write with conflict guard', async () => {
  const f = path.join(vault, 'Projects', 'Alpha.md');
  const r = await run(SCRIPT_READ, [f, 1e6]);
  assert.equal(r.content, '# Alpha\n- [ ] a\n');
  assert.equal((await run(SCRIPT_READ, [f, 3])).tooLarge, true);
  assert.equal((await run(SCRIPT_READ, [f + 'x', 1e6])).exists, false);

  const w1 = await run(SCRIPT_WRITE, [f, 'v2', r.content, r.mtimeMs, false]);
  assert.equal(w1.ok, true);
  assert.equal(fs.readFileSync(f, 'utf8'), 'v2');
  assert.deepEqual(fs.readdirSync(path.dirname(f)).filter((n) => n.includes('sp-tmp')), []);

  // External edit after our write -> conflict with stale base.
  await new Promise((res) => setTimeout(res, 20));
  fs.writeFileSync(f, 'edited in obsidian');
  const st = await run(SCRIPT_STAT, [f]);
  assert.notEqual(st.mtimeMs, w1.mtimeMs);
  const w2 = await run(SCRIPT_WRITE, [f, 'mine', 'v2', w1.mtimeMs, false]);
  assert.equal(w2.conflict, true);
  assert.equal(w2.content, 'edited in obsidian');
  assert.equal(fs.readFileSync(f, 'utf8'), 'edited in obsidian');

  // mtime changed but content identical to base -> no conflict.
  fs.writeFileSync(f, 'edited in obsidian');
  const w3 = await run(SCRIPT_WRITE, [f, 'mine', 'edited in obsidian', 0, false]);
  assert.equal(w3.ok, true);

  // force overwrites.
  fs.writeFileSync(f, 'other');
  assert.equal((await run(SCRIPT_WRITE, [f, 'forced', 'x', 0, true])).ok, true);
  assert.equal(fs.readFileSync(f, 'utf8'), 'forced');

  assert.match((await run(SCRIPT_WRITE, [path.join(vault, 'x.txt'), 'a', '', 0, true])).error, /non-\.md/);
  assert.equal((await run(SCRIPT_WRITE, [path.join(vault, 'Gone.md'), 'a', '', 0, false])).missing, true);
});

test('write through a symlink keeps the symlink', async () => {
  const link = path.join(vault, 'Link.md');
  const r = await run(SCRIPT_READ, [link, 1e6]);
  assert.equal((await run(SCRIPT_WRITE, [link, 'via link', r.content, r.mtimeMs, false])).ok, true);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(vault, 'Projects', 'Alpha.md'), 'utf8'), 'via link');
});

test('scan skips dot folders and limits entries', async () => {
  const r = await run(SCRIPT_SCAN, [vault, 1000]);
  assert.deepEqual(r.md, ['Link.md', 'Projects/Alpha.md']);
  assert.deepEqual(r.img, ['Projects/img/pic.png']);
  assert.equal(r.truncated, false);
  assert.equal((await run(SCRIPT_SCAN, [vault, 2])).truncated, true);
});

test('read image: relative to note, root-relative candidates, type and size limits', async () => {
  const note = path.join(vault, 'Projects', 'Alpha.md');
  const a = await run(SCRIPT_READ_IMAGE, [note, vault, 'img/pic.png', [], 1e6]);
  assert.equal(Buffer.from(a.b64, 'base64')[1], 80);
  const b = await run(SCRIPT_READ_IMAGE, [note, vault, 'pic.png', ['Projects/img/pic.png'], 1e6]);
  assert.ok(b.b64);
  assert.match((await run(SCRIPT_READ_IMAGE, [note, vault, 'notpng.txt', [], 1e6])).error, /not found/);
  assert.match((await run(SCRIPT_READ_IMAGE, [note, vault, 'img/pic.png', [], 2])).error, /too large/);
});

test('create: new note with folders, never overwrites, md only', async () => {
  const f = path.join(vault, 'Daily', '2026', '2026-01-04.md');
  assert.equal((await run(SCRIPT_CREATE, [f, '# hi'])).ok, true);
  assert.equal(fs.readFileSync(f, 'utf8'), '# hi');
  assert.equal((await run(SCRIPT_CREATE, [f, 'other'])).exists, true);
  assert.equal(fs.readFileSync(f, 'utf8'), '# hi');
  assert.match((await run(SCRIPT_CREATE, [path.join(vault, 'x.txt'), ''])).error, /\.md/);
});

test('backup: read missing, write, read back (in a fake home)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pmn-home-'));
  const fakeOs = { ...os, homedir: () => home };
  const r0 = await run(SCRIPT_BACKUP, ['read'], fakeOs);
  assert.equal(r0.exists, false);
  assert.equal(r0.path, path.join(home, '.sp-project-markdown-note.json'));
  assert.equal((await run(SCRIPT_BACKUP, ['write', '{"links":{"a":{"rel":"A.md"}}}'], fakeOs)).ok, true);
  const r1 = await run(SCRIPT_BACKUP, ['read'], fakeOs);
  assert.deepEqual(JSON.parse(r1.content), { links: { a: { rel: 'A.md' } } });
  assert.deepEqual(fs.readdirSync(home), ['.sp-project-markdown-note.json']);
});
