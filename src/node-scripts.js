// Scripts run by PluginAPI.executeNodeScript on the desktop app.
// They only require fs/path/os and avoid the words the host treats as
// "dangerous", so the host runs them in its fast in-process VM. Values come in
// through `args`, never by string interpolation.

export const SCRIPT_INFO = `
const os = require('os');
const path = require('path');
return { host: os.hostname(), platform: os.platform(), home: os.homedir(), sep: path.sep };
`;

// args: [input] -> { abs, name } | { error }
export const SCRIPT_CHECK_ROOT = `
const fs = require('fs');
const path = require('path');
const os = require('os');
let p = String(args[0] || '').trim().replace(/^["']+|["']+$/g, '');
if (!p) return { error: 'Enter a folder path.' };
if (p === '~' || p.startsWith('~/') || p.startsWith('~\\\\')) p = path.join(os.homedir(), p.slice(1));
if (!path.isAbsolute(p)) return { error: 'Use a full path, e.g. /Users/you/Vault.' };
p = path.resolve(p);
let st;
try { st = fs.statSync(p); } catch (e) { return { error: 'Folder not found: ' + p }; }
if (!st.isDirectory()) return { error: 'Not a folder: ' + p };
return { abs: p, name: path.basename(p) };
`;

// args: [root|null, input] -> { abs, rel|null } | { error }
export const SCRIPT_RESOLVE_LINK = `
const fs = require('fs');
const path = require('path');
const os = require('os');
const root = args[0] ? path.resolve(String(args[0])) : null;
let p = String(args[1] || '').trim().replace(/^["']+|["']+$/g, '');
if (!p) return { error: 'Enter a file path.' };
if (p.startsWith('file://')) {
  p = decodeURIComponent(p.slice(7));
  if (/^\\/[A-Za-z]:/.test(p)) p = p.slice(1);
}
if (p === '~' || p.startsWith('~/') || p.startsWith('~\\\\')) p = path.join(os.homedir(), p.slice(1));
if (!path.isAbsolute(p)) {
  if (!root) return { error: 'Use a full path, or set your vault folder in Settings first.' };
  p = path.resolve(root, p);
}
p = path.resolve(p);
if (!/\\.md$/i.test(p)) return { error: 'Only .md files can be linked.' };
let st;
try { st = fs.statSync(p); } catch (e) { return { error: 'File not found: ' + p }; }
if (!st.isFile()) return { error: 'Not a file: ' + p };
let rel = null;
if (root) {
  const r = path.relative(root, p);
  if (r && !r.startsWith('..') && !path.isAbsolute(r)) rel = r.split(path.sep).join('/');
}
return { abs: p, rel: rel };
`;

// args: [abs] -> { exists, isFile, mtimeMs, size }
export const SCRIPT_STAT = `
const fs = require('fs');
let st;
try { st = fs.statSync(String(args[0])); } catch (e) { return { exists: false }; }
return { exists: true, isFile: st.isFile(), mtimeMs: st.mtimeMs, size: st.size };
`;

// args: [abs, maxBytes] -> { exists, content?, mtimeMs?, tooLarge? }
export const SCRIPT_READ = `
const fs = require('fs');
const p = String(args[0]);
let st;
try { st = fs.statSync(p); } catch (e) { return { exists: false }; }
if (!st.isFile()) return { exists: false };
if (st.size > args[1]) return { exists: true, tooLarge: true, size: st.size };
return { exists: true, content: fs.readFileSync(p, 'utf8'), mtimeMs: st.mtimeMs, size: st.size };
`;

// args: [abs, content, baseContent, baseMtimeMs, force]
// -> { ok, mtimeMs } | { conflict, content, mtimeMs } | { error, missing? }
// Writes through symlinks to the real file, via a temp file + rename so a
// crash never leaves a half-written note.
export const SCRIPT_WRITE = `
const fs = require('fs');
const path = require('path');
const target = String(args[0]);
const content = String(args[1]);
const base = args[2];
const baseMtime = args[3];
const force = args[4] === true;
if (!/\\.md$/i.test(target)) return { error: 'Refusing to write a non-.md file.' };
let real;
try { real = fs.realpathSync(target); } catch (e) { return { error: 'File no longer exists.', missing: true }; }
const st = fs.statSync(real);
if (!force && st.mtimeMs !== baseMtime) {
  const current = fs.readFileSync(real, 'utf8');
  if (current !== base) return { conflict: true, content: current, mtimeMs: st.mtimeMs };
}
const tmp = path.join(path.dirname(real), '.' + path.basename(real) + '.sp-tmp');
try {
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, real);
} catch (e) {
  try { fs.unlinkSync(tmp); } catch (e2) {}
  fs.writeFileSync(real, content, 'utf8');
}
return { ok: true, mtimeMs: fs.statSync(real).mtimeMs };
`;

// args: [root, maxEntries] -> { md: string[], img: string[], truncated }
export const SCRIPT_SCAN = `
const fs = require('fs');
const path = require('path');
const root = String(args[0]);
const max = args[1];
const imgRe = /\\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const md = [];
const img = [];
let count = 0;
let truncated = false;
const stack = [['', 0]];
while (stack.length && !truncated) {
  const item = stack.pop();
  const rel = item[0];
  const depth = item[1];
  let ents;
  try { ents = fs.readdirSync(rel ? path.join(root, rel) : root, { withFileTypes: true }); } catch (e) { continue; }
  for (const d of ents) {
    if (d.name.startsWith('.') || d.name === 'node_modules') continue;
    if (++count > max) { truncated = true; break; }
    const r = rel ? rel + '/' + d.name : d.name;
    if (d.isDirectory()) { if (depth < 15) stack.push([r, depth + 1]); }
    else if (/\\.md$/i.test(d.name)) md.push(r);
    else if (imgRe.test(d.name)) img.push(r);
  }
}
md.sort();
img.sort();
return { md: md, img: img, truncated: truncated };
`;

// args: [noteAbs, root|null, src|null, extraRootRelPaths[], maxBytes]
// -> { b64, file } | { error }
export const SCRIPT_READ_IMAGE = `
const fs = require('fs');
const path = require('path');
const note = String(args[0]);
const root = args[1] ? String(args[1]) : null;
const src = args[2] ? String(args[2]) : null;
const extra = Array.isArray(args[3]) ? args[3] : [];
const max = args[4];
const imgRe = /\\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const cands = [];
if (src) {
  if (path.isAbsolute(src)) cands.push(src);
  else {
    cands.push(path.resolve(path.dirname(note), src));
    if (root) cands.push(path.resolve(root, src));
  }
}
if (root) for (const r of extra) cands.push(path.resolve(root, String(r)));
for (const p of cands) {
  if (!imgRe.test(p)) continue;
  let st;
  try { st = fs.statSync(p); } catch (e) { continue; }
  if (!st.isFile()) continue;
  if (st.size > max) return { error: 'Image too large to preview.' };
  return { b64: fs.readFileSync(p).toString('base64'), file: p };
}
return { error: 'Image not found.' };
`;

// args: [abs, content] -> { ok, mtimeMs } | { exists } | { error }
// Creates a new .md file (and missing folders); never overwrites.
export const SCRIPT_CREATE = `
const fs = require('fs');
const path = require('path');
const p = String(args[0]);
if (!/\\.md$/i.test(p)) return { error: 'Only .md files can be created.' };
try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch (e) { return { error: String(e.message) }; }
try { fs.writeFileSync(p, String(args[1] || ''), { encoding: 'utf8', flag: 'wx' }); }
catch (e) { if (e.code === 'EEXIST') return { exists: true }; return { error: String(e.message) }; }
return { ok: true, mtimeMs: fs.statSync(p).mtimeMs };
`;

// Local backup of the plugin's settings, outside Super Productivity's data, so
// removing/re-installing the plugin or resetting the app does not lose links.
// args: ['read'] -> { exists, content, path } ; ['write', content] -> { ok, path }
export const SCRIPT_BACKUP = `
const fs = require('fs');
const path = require('path');
const os = require('os');
const file = path.join(os.homedir(), '.sp-project-markdown-note.json');
if (args[0] === 'write') {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, String(args[1]), 'utf8');
  fs.renameSync(tmp, file);
  return { ok: true, path: file };
}
let content;
try { content = fs.readFileSync(file, 'utf8'); } catch (e) { return { exists: false, path: file }; }
return { exists: true, content: content, path: file };
`;

export const ALL_SCRIPTS = {
  SCRIPT_CREATE,
  SCRIPT_BACKUP,
  SCRIPT_INFO,
  SCRIPT_CHECK_ROOT,
  SCRIPT_RESOLVE_LINK,
  SCRIPT_STAT,
  SCRIPT_READ,
  SCRIPT_WRITE,
  SCRIPT_SCAN,
  SCRIPT_READ_IMAGE,
};
