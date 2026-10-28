// Project Markdown Note — iframe UI (side panel + full-page view).
// Uses only PluginAPI methods from docs/plugin-development.md, plus
// getActiveWorkContext() and the workContextChange hook (feature-detected) so the
// note follows the project you are viewing, like the built-in project notes.
import {
  createMarkdownRenderer,
  escapeHtml,
  findEmbedCandidates,
  joinRoot,
  mimeForPath,
  obsidianOpenUri,
  obsidianWikiUri,
  resolveRelPosix,
  searchNotes,
  suggestForProject,
  buildTree,
  toggleTask,
  findNoteCandidates,
  extractSection,
  dailyNoteRel,
  fillTemplate,
  formatDate,
} from './core.js';
import {
  SCRIPT_INFO,
  SCRIPT_CHECK_ROOT,
  SCRIPT_RESOLVE_LINK,
  SCRIPT_STAT,
  SCRIPT_READ,
  SCRIPT_WRITE,
  SCRIPT_SCAN,
  SCRIPT_READ_IMAGE,
  SCRIPT_CREATE,
  SCRIPT_BACKUP,
} from './node-scripts.js';

const SAVE_DELAY_MS = 1000;
const POLL_MS = 4000;
const PREVIEW_DELAY_MS = 150;
const MAX_NOTE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_SCAN_ENTRIES = 20000;
const WIDE_PX = 760;
const MAX_EMBED_DEPTH = 3;
const NOTE_CACHE_MS = 30000;

const $ = (id) => document.getElementById(id);
const el = {
  projName: $('projName'),
  projSelect: $('projSelect'),
  fileName: $('fileName'),
  status: $('status'),
  modeSeg: $('modeSeg'),
  btnExpand: $('btnExpand'),
  btnMenu: $('btnMenu'),
  menu: $('menu'),
  viewMessage: $('viewMessage'),
  viewSettings: $('viewSettings'),
  viewLink: $('viewLink'),
  viewNote: $('viewNote'),
  hostName: $('hostName'),
  rootInput: $('rootInput'),
  vaultInput: $('vaultInput'),
  btnSaveSettings: $('btnSaveSettings'),
  btnSettingsBack: $('btnSettingsBack'),
  settingsError: $('settingsError'),
  linkTitle: $('linkTitle'),
  linkBrowse: $('linkBrowse'),
  linkNoRoot: $('linkNoRoot'),
  lnkOpenSettings: $('lnkOpenSettings'),
  linkSearch: $('linkSearch'),
  linkTree: $('linkTree'),
  btnRescan: $('btnRescan'),
  scanInfo: $('scanInfo'),
  linkPath: $('linkPath'),
  btnLinkPath: $('btnLinkPath'),
  linkError: $('linkError'),
  btnLinkCancel: $('btnLinkCancel'),
  noteWrap: $('noteWrap'),
  editor: $('editor'),
  preview: $('preview'),
};

const S = {
  host: null,
  sep: '/',
  root: null,
  vault: '',
  projects: [],
  mode: 'project',
  daily: {},
  dailyEnabled: true,
  dailyKey: null,
  dailyDetected: null,
  noteCache: new Map(),
  notePending: new Map(),
  autoFollow: false,
  ctxMode: 'manual',
  ctx: null,
  manualProjectId: null,
  projectId: null,
  projectTitle: '',
  link: null,
  file: null,
  base: '',
  buffer: '',
  mtime: null,
  dirty: false,
  saving: false,
  saveAgain: false,
  writeGen: 0,
  checking: false,
  conflictOpen: false,
  conflictParked: false,
  editing: false,
  view: 'message',
  scan: null,
  tree: null,
  linkChanging: false,
  loadSeq: 0,
  imgCache: new Map(),
  imgPending: new Map(),
  saveErrorShown: false,
};

const api = () => window.PluginAPI;
// marked is loaded by plugin.js into the app window (see src/plugin.js).
const sharedLib = (() => {
  try {
    return window.parent.__projectMarkdownNoteLib || window.__projectMarkdownNoteLib || null;
  } catch {
    return null;
  }
})();
const renderMd = sharedLib
  ? createMarkdownRenderer(sharedLib.Marked)
  : (src) =>
      `<p class="hint">Preview unavailable: the plugin's main script did not load. Disable and re-enable the plugin.</p><pre>${escapeHtml(
        src,
      )}</pre>`;

// ---------- Plugin API helpers ----------

const runNode = async (script, args = [], timeout = 15000) => {
  const a = api();
  if (!a || typeof a.executeNodeScript !== 'function') throw new Error('NO_NODE');
  const r = await a.executeNodeScript({ script, args, timeout });
  if (!r || !r.success) throw new Error((r && r.error) || 'Node script failed');
  return r.result;
};

// All plugin data lives in one synced JSON blob, because older hosts (18.x)
// ignore the key argument of persistDataSynced/loadSyncedData.
// { v, roots: { [hostname]: folder }, vault, links: { [projectId]: { rel } | { abs, host } },
//   daily: { enabled, folder, format, template } }
const emptyStore = () => ({ v: 1, roots: {}, vault: '', links: {}, daily: {} });
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const loadStore = async () => {
  try {
    const raw = await api().loadSyncedData();
    const d = raw ? JSON.parse(raw) : null;
    if (isObj(d)) {
      return {
        v: 1,
        roots: isObj(d.roots) ? d.roots : {},
        vault: typeof d.vault === 'string' ? d.vault : '',
        links: isObj(d.links) ? d.links : {},
        daily: isObj(d.daily) ? d.daily : {},
      };
    }
  } catch {
    /* fall through */
  }
  return emptyStore();
};
// Older hosts reject persist calls less than 1 s apart, so writes are queued,
// spaced out and retried.
const PERSIST_GAP_MS = 1100;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
let storeQueue = Promise.resolve();
let lastPersistAt = 0;
const updateStore = (mutate) => {
  storeQueue = storeQueue
    .catch(() => {})
    .then(async () => {
      for (let attempt = 0; ; attempt++) {
        const wait = lastPersistAt + PERSIST_GAP_MS - Date.now();
        if (wait > 0) await sleep(wait);
        const d = await loadStore();
        mutate(d);
        try {
          lastPersistAt = Date.now();
          await api().persistDataSynced(JSON.stringify(d));
          writeBackup(d);
          return d;
        } catch (e) {
          if (attempt >= 3 || !/rate/i.test(String(e && e.message))) throw e;
        }
      }
    });
  return storeQueue;
};
// Local backup file (see SCRIPT_BACKUP): survives removing/re-installing the plugin.
const writeBackup = (d) => {
  runNode(SCRIPT_BACKUP, ['write', JSON.stringify({ ...d, savedAt: new Date().toISOString() }, null, 2)]).catch(
    () => {},
  );
};
const hasContent = (d) => isObj(d) && (Object.keys(d.links || {}).length > 0 || Object.keys(d.roots || {}).length > 0);
const replaceStore = (src) =>
  updateStore((d) => {
    d.roots = isObj(src.roots) ? src.roots : {};
    d.links = isObj(src.links) ? src.links : {};
    d.vault = typeof src.vault === 'string' ? src.vault : '';
    d.daily = isObj(src.daily) ? src.daily : {};
  });

const validLink = (l) =>
  isObj(l) && (typeof l.rel === 'string' || typeof l.abs === 'string') ? l : null;

const snack = (msg, type = 'INFO') => {
  try {
    api().showSnack({ msg, type });
  } catch {
    /* ignore */
  }
};

// In-panel dialog. The host's openDialog cannot report which button an iframe
// plugin clicked on 18.x hosts, so confirmations are rendered here instead.
let closeModal = null;
const askDialog = (title, html, labels, primary) =>
  new Promise((resolve) => {
    if (closeModal) closeModal(undefined);
    const modal = $('modal');
    const prevFocus = document.activeElement;
    $('modalTitle').textContent = title;
    $('modalBody').innerHTML = html;
    const row = $('modalButtons');
    row.innerHTML = '';
    const done = (v) => {
      modal.hidden = true;
      closeModal = null;
      document.removeEventListener('keydown', onKey, true);
      if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === 'function' && !prevFocus.hidden) {
        prevFocus.focus();
      }
      resolve(v);
    };
    const onKey = (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        done(undefined);
      }
    };
    for (const label of labels) {
      const b = document.createElement('button');
      b.textContent = label;
      if (label === primary) b.className = 'btn-primary';
      b.addEventListener('click', () => done(label));
      row.appendChild(b);
    }
    closeModal = done;
    document.addEventListener('keydown', onKey, true);
    modal.hidden = false;
    const focusBtn = [...row.children].find((b) => b.textContent === primary);
    if (focusBtn) focusBtn.focus();
  });

const confirmDialog = async (title, html, okLabel) =>
  (await askDialog(title, html, ['Cancel', okLabel], okLabel)) === okLabel;

const openExternal = (uri) => {
  if (uri) window.open(uri, '_blank', 'noopener');
};

const vaultName = () => S.vault || (S.root ? S.root.split(/[\\/]/).filter(Boolean).pop() : '');

const isPermissionError = (e) => /permission|denied|consent|not allowed/i.test(String(e && e.message));

// ---------- View helpers ----------

const showView = (name) => {
  S.view = name;
  el.viewMessage.hidden = name !== 'message';
  el.viewSettings.hidden = name !== 'settings';
  el.viewLink.hidden = name !== 'link';
  el.viewNote.hidden = name !== 'note';
  el.modeSeg.hidden = name !== 'note';
  closeMenu();
  if (name === 'note') applyLayout();
};

const showMessage = (html, actions = []) => {
  el.viewMessage.innerHTML = html;
  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'row';
    for (const act of actions) {
      const b = document.createElement('button');
      b.textContent = act.label;
      if (act.primary) b.className = 'btn-primary';
      b.addEventListener('click', act.fn);
      row.appendChild(b);
    }
    el.viewMessage.appendChild(row);
  }
  showView('message');
};

const setStatus = (text, warn = false) => {
  el.status.textContent = text;
  el.status.classList.toggle('warn', warn);
};

const isWide = () => window.innerWidth >= WIDE_PX;

// Which host surface this iframe is: the side panel or the full-page view
// (#/plugins/<id>/index). Both can be open at once on newer hosts, so check
// where our <iframe> sits in the host page first; the route and width are
// fallbacks for hosts where that is not readable.
const detectFullPage = () => {
  try {
    const fe = window.frameElement;
    if (fe && typeof fe.closest === 'function') {
      if (fe.closest('plugin-panel-container, right-panel-content')) return false;
      if (fe.closest('.route-wrapper')) return true;
    }
  } catch {
    /* not readable */
  }
  try {
    if (window.parent !== window) return /^#\/plugins\/[^/]+\/index/.test(window.parent.location.hash || '');
  } catch {
    /* not readable */
  }
  return isWide();
};
const IS_FULL_PAGE = detectFullPage();

const parentHash = () => {
  try {
    return window.parent.location.hash;
  } catch {
    return null;
  }
};

// Leave the full-page view: go back to wherever the user came from (normally the
// project); if there is no history entry to return to, open the project itself.
const exitFullPage = async () => {
  await flushSave();
  const before = parentHash();
  try {
    if (window.parent.history.length > 1) window.parent.history.back();
  } catch {
    /* fall through to the route below */
  }
  setTimeout(() => {
    try {
      if (parentHash() === before) {
        window.parent.location.hash = S.projectId
          ? `#/project/${encodeURIComponent(S.projectId)}/tasks`
          : '#/tag/TODAY/tasks';
      }
    } catch {
      /* ignore */
    }
  }, 400);
};

const applyLayout = () => {
  const wide = isWide();
  const [bPrev, bEdit, bSplit] = el.modeSeg.querySelectorAll('button');
  bEdit.hidden = wide;
  bSplit.hidden = !wide;
  bPrev.classList.toggle('active', !S.editing);
  bEdit.classList.toggle('active', S.editing);
  bSplit.classList.toggle('active', S.editing);
  el.editor.hidden = !S.editing;
  el.preview.hidden = S.editing && !wide;
  el.noteWrap.classList.toggle('split', S.editing && wide);
  el.btnExpand.hidden = false;
  if (!el.preview.hidden) renderPreview();
};

const renderHeader = () => {
  const ctxIsProject = S.ctx && S.ctx.type === 'PROJECT';
  const daily = S.mode === 'daily';
  const showSelect = !daily && (!S.autoFollow || !ctxIsProject);
  el.projSelect.hidden = !showSelect;
  if (showSelect) {
    el.projName.textContent = S.autoFollow && S.ctx ? `${S.ctx.title} — pick a project:` : 'Project:';
    const opts = ['<option value="">— Choose project —</option>'].concat(
      S.projects.map(
        (p) =>
          `<option value="${escapeHtml(p.id)}"${p.id === S.projectId ? ' selected' : ''}>${escapeHtml(
            p.title,
          )}</option>`,
      ),
    );
    el.projSelect.innerHTML = opts.join('');
  } else {
    el.projName.textContent = daily ? `Today — ${formatDate(new Date(), 'ddd D MMM')}` : S.projectTitle || 'Project note';
  }
  el.fileName.textContent = S.file ? S.file.rel || S.file.abs : '';
  el.fileName.title = S.file ? S.file.abs : '';
};

// ---------- Settings ----------

const applySettings = (d) => {
  S.root = typeof d.roots[S.host] === 'string' && d.roots[S.host] ? d.roots[S.host] : null;
  S.vault = d.vault || '';
  S.daily = d.daily || {};
  S.dailyEnabled = S.daily.enabled !== false;
};

const loadSettings = async () => {
  const d = await loadStore();
  applySettings(d);
  return d;
};

const openSettings = () => {
  el.hostName.textContent = S.host || 'this computer';
  el.rootInput.value = S.root || '';
  el.vaultInput.value = S.vault || '';
  $('dailyEnabled').checked = S.dailyEnabled;
  $('dailyFolder').value = S.daily.folder || '';
  $('dailyFormat').value = S.daily.format || '';
  $('dailyTemplate').value = S.daily.template || '';
  el.settingsError.textContent = '';
  showView('settings');
  detectDailyConfig().then((det) => {
    $('dailyFolder').placeholder = det.folder ? `${det.folder} (from Obsidian)` : 'Vault root';
    $('dailyFormat').placeholder = `${det.format || 'YYYY-MM-DD'}${det.format ? ' (from Obsidian)' : ''}`;
    $('dailyTemplate').placeholder = det.template ? `${det.template} (from Obsidian)` : 'None';
  });
  runNode(SCRIPT_BACKUP, ['read'])
    .then((b) => {
      $('backupPath').textContent = b.path;
    })
    .catch(() => {});
};

const saveSettings = async () => {
  el.settingsError.textContent = '';
  const rootIn = el.rootInput.value.trim();
  let newRoot = null;
  if (rootIn) {
    let r;
    try {
      r = await runNode(SCRIPT_CHECK_ROOT, [rootIn]);
    } catch (e) {
      el.settingsError.textContent = String(e.message || e);
      return;
    }
    if (r.error) {
      el.settingsError.textContent = r.error;
      return;
    }
    newRoot = r.abs;
  }
  const vaultIn = el.vaultInput.value.trim();
  const daily = {
    enabled: $('dailyEnabled').checked,
    folder: $('dailyFolder').value.trim(),
    format: $('dailyFormat').value.trim(),
    template: $('dailyTemplate').value.trim(),
  };
  try {
    await updateStore((d) => {
      if (newRoot) d.roots[S.host] = newRoot;
      else delete d.roots[S.host];
      d.vault = vaultIn;
      d.daily = daily;
    });
  } catch (e) {
    el.settingsError.textContent = `Could not save settings: ${e.message || e}`;
    return;
  }
  S.root = newRoot;
  S.vault = vaultIn;
  S.daily = daily;
  S.dailyEnabled = daily.enabled;
  S.dailyDetected = null;
  S.scan = null;
  S.tree = null;
  snack('Settings saved', 'SUCCESS');
  await reopenProject();
};

const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
};

const exportSettings = async () => {
  const d = await loadStore();
  const json = JSON.stringify({ ...d, exportedAt: new Date().toISOString() }, null, 2);
  const choice = await askDialog(
    'Export settings',
    `<p class="hint">Folders, project links and daily-note settings. Keep a copy, or paste it into Import on another install.</p><textarea class="io" readonly>${escapeHtml(
      json,
    )}</textarea>`,
    ['Close', 'Copy'],
    'Copy',
  );
  if (choice === 'Copy') snack((await copyText(json)) ? 'Settings copied' : 'Select the text and copy it manually', 'INFO');
};

const importSettings = async () => {
  const choice = await askDialog(
    'Import settings',
    '<p class="hint">Paste exported settings. This replaces the current folders, project links and daily-note settings.</p><textarea class="io" id="importText" spellcheck="false"></textarea>',
    ['Cancel', 'Import'],
    'Import',
  );
  if (choice !== 'Import') return;
  let parsed;
  try {
    parsed = JSON.parse($('importText').value);
  } catch {
    snack('That is not valid exported settings text.', 'ERROR');
    return;
  }
  if (!isObj(parsed) || (!isObj(parsed.links) && !isObj(parsed.roots))) {
    snack('That text does not contain plugin settings.', 'ERROR');
    return;
  }
  try {
    await replaceStore(parsed);
  } catch (e) {
    snack(`Could not import: ${e.message || e}`, 'ERROR');
    return;
  }
  await loadSettings();
  S.scan = null;
  S.tree = null;
  S.dailyDetected = null;
  snack('Settings imported', 'SUCCESS');
  await reopenProject();
};

// ---------- Daily note (Today view) ----------

// Obsidian's daily-notes settings live in <vault>/.obsidian/daily-notes.json.
const detectDailyConfig = async () => {
  if (!S.root) return {};
  if (S.dailyDetected && S.dailyDetected.root === S.root) return S.dailyDetected.cfg;
  let cfg = {};
  try {
    const r = await runNode(SCRIPT_READ, [joinRoot(S.root, '.obsidian/daily-notes.json', S.sep), 65536]);
    if (r.exists && r.content) {
      const j = JSON.parse(r.content);
      cfg = { folder: j.folder || '', format: j.format || '', template: j.template || '' };
    }
  } catch {
    /* not configured */
  }
  S.dailyDetected = { root: S.root, cfg };
  return cfg;
};

const dailyConfig = async () => {
  const det = await detectDailyConfig();
  return {
    folder: S.daily.folder || det.folder || '',
    format: S.daily.format || det.format || 'YYYY-MM-DD',
    template: S.daily.template || det.template || '',
  };
};

const todayKey = () => formatDate(new Date(), 'YYYY-MM-DD');

const selectDaily = async (force = false) => {
  if (!force && S.mode === 'daily' && S.dailyKey === todayKey() && S.file) return;
  await flushSave();
  const seq = ++S.loadSeq;
  S.mode = 'daily';
  S.dailyKey = todayKey();
  S.projectId = null;
  S.projectTitle = 'Today';
  resetFile();
  renderHeader();
  if (!S.root) {
    showMessage('<p>Today shows your daily note. Set your vault folder first.</p>', [
      { label: 'Open settings', primary: true, fn: openSettings },
    ]);
    return;
  }
  const cfg = await dailyConfig();
  if (seq !== S.loadSeq) return;
  S.link = { rel: dailyNoteRel(cfg, new Date()), daily: true };
  await openLinkedFile(seq);
};

const createDailyNote = async () => {
  const cfg = await dailyConfig();
  const now = new Date();
  const rel = dailyNoteRel(cfg, now);
  let content = '';
  if (cfg.template) {
    const tplRel = /\.md$/i.test(cfg.template) ? cfg.template : `${cfg.template}.md`;
    try {
      const t = await runNode(SCRIPT_READ, [joinRoot(S.root, tplRel, S.sep), MAX_NOTE_BYTES]);
      if (t.exists && !t.tooLarge) {
        const title = rel.slice(rel.lastIndexOf('/') + 1).replace(/\.md$/i, '');
        content = fillTemplate(splitTemplateFrontmatter(t.content), now, title, cfg.format);
      } else snack(`Template not found: ${tplRel}`, 'WARNING');
    } catch {
      /* create empty */
    }
  }
  try {
    const r = await runNode(SCRIPT_CREATE, [joinRoot(S.root, rel, S.sep), content]);
    if (r.error) {
      snack(`Could not create the note: ${r.error}`, 'ERROR');
      return;
    }
  } catch (e) {
    showNodeError(e);
    return;
  }
  await selectDaily(true);
};

// Templates keep their own frontmatter; nothing to strip, but normalise line endings.
const splitTemplateFrontmatter = (t) => t.replace(/\r\n/g, '\n');

// ---------- Project selection ----------

const projectTitle = (id) => (S.projects.find((p) => p.id === id) || {}).title || '';

const refreshProjects = async () => {
  try {
    const list = (await api().getAllProjects()) || [];
    S.projects = list.filter((p) => !p.isArchived).sort((a, b) => a.title.localeCompare(b.title));
  } catch {
    S.projects = [];
  }
};

const onContext = async (ctx) => {
  S.ctx = ctx || null;
  if (ctx && ctx.type === 'PROJECT') {
    renderHeader();
    await selectProject(ctx.id, ctx.title);
    return;
  }
  if (ctx && ctx.type === 'TODAY' && S.dailyEnabled) {
    await selectDaily();
    return;
  }
  if (S.manualProjectId) {
    await selectProject(S.manualProjectId, projectTitle(S.manualProjectId));
    return;
  }
  await flushSave();
  S.loadSeq++;
  S.mode = 'project';
  S.projectId = null;
  resetFile();
  await refreshProjects();
  renderHeader();
  showMessage(
    '<p>Only projects have a linked note. Pick a project above, or open a project.</p>',
  );
};

const resetFile = () => {
  S.link = null;
  S.file = null;
  S.base = '';
  S.buffer = '';
  S.mtime = null;
  S.dirty = false;
  S.conflictParked = false;
  S.imgCache.clear();
  S.imgPending.clear();
  S.noteCache.clear();
  S.notePending.clear();
  el.editor.value = '';
  el.preview.innerHTML = '';
  setStatus('');
};

const selectProject = async (id, title, force = false) => {
  if (!force && S.mode === 'project' && id === S.projectId && S.file) return;
  await flushSave();
  const seq = ++S.loadSeq;
  S.mode = 'project';
  S.projectId = id || null;
  S.projectTitle = title || projectTitle(id);
  resetFile();
  renderHeader();
  if (!S.projectId) {
    showMessage('<p>Choose a project above to see its linked note.</p>');
    return;
  }
  const store = await loadStore();
  if (seq !== S.loadSeq) return;
  S.link = validLink(store.links[S.projectId]);
  rememberProject(S.projectId);
  if (!S.link) {
    await openLinkView(false);
    return;
  }
  await openLinkedFile(seq);
};

const reopenProject = () =>
  S.mode === 'daily' ? selectDaily(true) : selectProject(S.projectId, S.projectTitle, true);

// ---------- Linked file ----------

const openLinkedFile = async (seq) => {
  const link = S.link;
  let rel = link.rel || null;
  let abs = null;
  if (rel) {
    if (!S.root) {
      showMessage(
        `<p>This project is linked to <b>${escapeHtml(rel)}</b> in your vault, but no vault folder is set on this computer (${escapeHtml(
          S.host,
        )}).</p>`,
        [
          { label: 'Open settings', primary: true, fn: openSettings },
          { label: 'Link another file', fn: () => openLinkView(true) },
        ],
      );
      return;
    }
    abs = joinRoot(S.root, rel, S.sep);
  } else {
    abs = link.abs;
    if (S.root) {
      try {
        const r = await runNode(SCRIPT_RESOLVE_LINK, [S.root, abs]);
        if (r && r.rel) {
          rel = r.rel;
          abs = r.abs;
          const pid = S.projectId;
          S.link = { rel };
          await updateStore((d) => {
            d.links[pid] = { rel };
          });
        }
      } catch {
        /* keep absolute link */
      }
    }
  }
  if (seq !== S.loadSeq) return;
  S.file = { abs, rel };
  renderHeader();
  let r;
  try {
    r = await runNode(SCRIPT_READ, [abs, MAX_NOTE_BYTES]);
  } catch (e) {
    if (seq === S.loadSeq) showNodeError(e);
    return;
  }
  if (seq !== S.loadSeq) return;
  if (!r.exists && link.daily) {
    S.file = null;
    renderHeader();
    showMessage(`<p>No daily note for today yet.</p><p><code>${escapeHtml(rel)}</code></p>`, [
      { label: "Create today's note", primary: true, fn: createDailyNote },
      { label: 'Daily note settings', fn: openSettings },
    ]);
    return;
  }
  if (!r.exists) {
    const other =
      !rel && link.host && link.host !== S.host
        ? `<p class="hint">It was linked by full path on <b>${escapeHtml(
            link.host,
          )}</b>. Set a vault folder that contains it, or link the file again on this computer.</p>`
        : '';
    S.file = null;
    renderHeader();
    showMessage(`<p>The linked file was not found:</p><p><code>${escapeHtml(abs)}</code></p>${other}`, [
      { label: 'Link another file', primary: true, fn: () => openLinkView(true) },
      { label: 'Retry', fn: reopenProject },
      { label: 'Settings', fn: openSettings },
    ]);
    return;
  }
  if (r.tooLarge) {
    showMessage(`<p>This file is too large to edit here (${Math.round(r.size / 1024)} KB).</p>`, [
      { label: 'Link another file', fn: () => openLinkView(true) },
    ]);
    return;
  }
  S.base = r.content;
  S.buffer = r.content;
  S.mtime = r.mtimeMs;
  S.dirty = false;
  el.editor.value = r.content;
  setStatus('');
  showView('note');
};

const showNodeError = (e) => {
  if (isPermissionError(e)) {
    showMessage(
      '<p>This plugin needs permission to read and write your note files.</p><p class="hint">Super Productivity asks once per computer. If you chose Deny, disable and re-enable the plugin in Settings → Plugins to see the prompt again.</p>',
      [{ label: 'Retry', primary: true, fn: () => location.reload() }],
    );
  } else {
    showMessage(`<p>Could not access the file.</p><p class="hint">${escapeHtml(e.message || e)}</p>`, [
      { label: 'Retry', primary: true, fn: reopenProject },
    ]);
  }
};

const applyRemote = (content, mtimeMs, note = 'Reloaded') => {
  S.base = content;
  S.buffer = content;
  S.mtime = mtimeMs;
  S.dirty = false;
  S.conflictParked = false;
  const { selectionStart: a, selectionEnd: b } = el.editor;
  el.editor.value = content;
  if (document.activeElement === el.editor) {
    el.editor.setSelectionRange(Math.min(a, content.length), Math.min(b, content.length));
  }
  S.imgCache.clear();
  renderPreview();
  setStatus(note);
};

// ---------- Saving & conflicts ----------

let saveTimer = null;
const scheduleSave = (delay = SAVE_DELAY_MS) => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save(), delay);
};

const markDirty = (delay) => {
  S.dirty = S.buffer !== S.base;
  if (S.dirty) {
    S.conflictParked = false;
    setStatus('Unsaved');
    scheduleSave(delay);
  } else {
    clearTimeout(saveTimer);
    setStatus('Saved');
  }
};

const save = async (explicit = false) => {
  clearTimeout(saveTimer);
  if (!S.file || !S.dirty || S.conflictOpen) return;
  if (S.conflictParked && !explicit) return;
  if (S.saving) {
    S.saveAgain = true;
    return;
  }
  S.saving = true;
  S.writeGen++;
  setStatus('Saving…');
  const content = S.buffer;
  const file = S.file;
  let r;
  try {
    r = await runNode(SCRIPT_WRITE, [file.abs, content, S.base, S.mtime, false]);
  } catch (e) {
    S.saving = false;
    setStatus('Save failed', true);
    if (!S.saveErrorShown) {
      S.saveErrorShown = true;
      snack(`Could not save note: ${e.message || e}`, 'ERROR');
    }
    return;
  }
  S.saving = false;
  if (file !== S.file) return;
  if (r.ok) {
    S.saveErrorShown = false;
    S.base = content;
    S.mtime = r.mtimeMs;
    S.dirty = S.buffer !== S.base;
    setStatus(S.dirty ? 'Unsaved' : 'Saved');
    if (S.dirty || S.saveAgain) {
      S.saveAgain = false;
      scheduleSave(300);
    }
    return;
  }
  S.saveAgain = false;
  if (r.conflict) {
    await resolveConflict(r);
    return;
  }
  setStatus(r.missing ? 'File missing' : 'Save failed', true);
  snack(
    r.missing
      ? 'The linked file no longer exists. Your text is still here; use ⋯ → Change linked file.'
      : `Could not save note: ${r.error}`,
    'ERROR',
  );
};

const flushSave = async () => {
  if (!S.file) return;
  if (S.dirty && !S.conflictOpen) await save();
  for (let i = 0; i < 100 && S.saving; i++) await new Promise((res) => setTimeout(res, 50));
};

const resolveConflict = async (remote) => {
  S.conflictOpen = true;
  const name = escapeHtml(S.file ? S.file.rel || S.file.abs : 'The note');
  let choice;
  try {
    choice = await askDialog(
      'Note changed in another app',
      `<p><b>${name}</b> was changed outside Super Productivity while you had unsaved edits here.</p><p><b>Keep mine</b> overwrites the file with your version.<br><b>Use file</b> loads the file and discards your unsaved edits.</p>`,
      ['Use file', 'Keep mine'],
      'Keep mine',
    );
  } finally {
    S.conflictOpen = false;
  }
  if (choice === 'Keep mine') {
    S.base = remote.content;
    S.mtime = remote.mtimeMs;
    S.dirty = S.buffer !== S.base;
    await save(true);
  } else if (choice === 'Use file') {
    applyRemote(remote.content, remote.mtimeMs, 'Loaded file version');
  } else {
    S.conflictParked = true;
    setStatus('Conflict – not saved', true);
  }
};

const checkExternal = async () => {
  if (!S.file || S.view !== 'note' || S.saving || S.conflictOpen || S.checking || document.hidden) return;
  S.checking = true;
  const gen = S.writeGen;
  const file = S.file;
  try {
    const st = await runNode(SCRIPT_STAT, [file.abs]);
    if (file !== S.file) return;
    if (!st.exists) {
      setStatus('File missing', true);
      return;
    }
    if (st.mtimeMs === S.mtime) return;
    const r = await runNode(SCRIPT_READ, [file.abs, MAX_NOTE_BYTES]);
    if (file !== S.file || S.saving || gen !== S.writeGen || !r.exists || r.tooLarge) return;
    if (r.content === S.base) {
      S.mtime = r.mtimeMs;
      return;
    }
    if (!S.dirty) applyRemote(r.content, r.mtimeMs);
    else if (!S.conflictParked) await resolveConflict(r);
  } catch {
    /* transient; try again on next poll */
  } finally {
    S.checking = false;
  }
};

// ---------- Preview ----------

let previewTimer = null;
const schedulePreview = () => {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, PREVIEW_DELAY_MS);
};

const renderPreview = () => {
  if (el.preview.hidden || S.view !== 'note') return;
  const src = S.buffer;
  if (!src.trim()) {
    el.preview.innerHTML = `<p class="empty-preview">Empty note. Use ${
      isWide() ? 'Split' : 'Edit'
    } to start writing.</p>`;
    return;
  }
  let html;
  try {
    html = renderMd(src);
  } catch {
    html = `<pre>${escapeHtml(src)}</pre>`;
  }
  el.preview.innerHTML = html;
  el.preview.querySelectorAll('input[type="checkbox"]').forEach((cb, i) => {
    cb.disabled = false;
    cb.dataset.taskIndex = String(i);
  });
  if (S.file) renderEmbeds(el.preview, 0, new Set([`${S.file.abs}#`]), S.file.rel || '', S.file.abs);
  loadImages(el.preview);
};

// ---------- Embedded notes: ![[Note]], ![[Note#Heading]], ![[Note#^block]] ----------

const readNote = (abs) => {
  const c = S.noteCache.get(abs);
  if (c && Date.now() - c.at < NOTE_CACHE_MS) return Promise.resolve(c);
  if (S.notePending.has(abs)) return S.notePending.get(abs);
  const p = runNode(SCRIPT_READ, [abs, MAX_NOTE_BYTES])
    .then((r) => {
      const v = r.exists && !r.tooLarge ? { content: r.content, at: Date.now() } : null;
      if (v) S.noteCache.set(abs, v);
      return v;
    })
    .finally(() => S.notePending.delete(abs));
  S.notePending.set(abs, p);
  return p;
};

const renderEmbeds = (container, depth, chain, baseRel, baseAbs) => {
  for (const span of container.querySelectorAll('.mn-embed:not([data-filled])')) {
    span.dataset.filled = '1';
    fillEmbed(span, depth, chain, baseRel, baseAbs);
  }
};

const fillEmbed = async (span, depth, chain, baseRel, baseAbs) => {
  const body = span.querySelector('.mn-embed-body');
  const target = span.dataset.embedNote || '';
  const anchor = span.dataset.embedAnchor || '';
  const say = (t) => {
    body.innerHTML = `<span class="hint">${escapeHtml(t)}</span>`;
  };
  if (depth >= MAX_EMBED_DEPTH) return say('Nested too deeply to show.');
  try {
    let abs = baseAbs;
    let rel = baseRel;
    if (target) {
      if (!S.root) return say('Set your vault folder in Settings to show embedded notes.');
      const scan = await ensureScan();
      const cands = findNoteCandidates(scan.md, target, baseRel);
      if (!cands.length) return say(`“${target}” is not in your vault.`);
      rel = cands[0];
      abs = joinRoot(S.root, rel, S.sep);
    }
    const key = `${abs}#${anchor}`;
    if (chain.has(key)) return say('This embed includes itself; not shown again.');
    const content = S.file && abs === S.file.abs ? S.buffer : ((await readNote(abs)) || {}).content;
    if (content == null) return say('Could not read this note.');
    const section = extractSection(content, anchor);
    if (section == null) return say(`Section “${anchor}” not found.`);
    if (!span.isConnected) return;
    span.dataset.noteAbs = abs;
    body.innerHTML = section.trim() ? renderMd(section) : '<span class="hint">(empty)</span>';
    body.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.disabled = true;
      delete cb.dataset.taskIndex;
    });
    renderEmbeds(body, depth + 1, new Set([...chain, key]), rel || '', abs);
    loadImages(body);
  } catch (e) {
    say(`Could not load: ${e.message || e}`);
  }
};

const loadImages = (container) => {
  for (const img of container.querySelectorAll('img.mn-img:not([data-loading])')) {
    img.dataset.loading = '1';
    const local = img.getAttribute('data-local');
    const embed = img.getAttribute('data-embed');
    const host = img.parentElement && img.parentElement.closest('.mn-embed[data-note-abs]');
    const baseAbs = host ? host.dataset.noteAbs : S.file && S.file.abs;
    const key = local ? `L:${baseAbs}|${local}` : `E:${embed}`;
    if (S.imgCache.has(key)) {
      applyImage(img, S.imgCache.get(key));
      continue;
    }
    if (!S.imgPending.has(key)) {
      const file = S.file;
      S.imgPending.set(
        key,
        fetchImage(local, embed, baseAbs)
          .catch((e) => ({ error: e.message || String(e) }))
          .then((val) => {
            if (file === S.file) S.imgCache.set(key, val);
            S.imgPending.delete(key);
            return val;
          }),
      );
    }
    S.imgPending.get(key).then((val) => {
      if (img.isConnected) applyImage(img, val);
    });
  }
};

const safeDecode = (s) => {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
};

const fetchImage = async (local, embed, baseAbs) => {
  if (!S.file || !baseAbs) return { error: 'No file' };
  let src;
  let extra = [];
  if (local) {
    src = safeDecode(local);
  } else {
    src = embed;
    if (S.root) {
      const scan = await ensureScan();
      extra = findEmbedCandidates(scan.img, embed);
    }
  }
  const r = await runNode(SCRIPT_READ_IMAGE, [baseAbs, S.root, src, extra, MAX_IMAGE_BYTES], 20000);
  if (r && r.b64) return { src: `data:${mimeForPath(r.file)};base64,${r.b64}` };
  return { error: (r && r.error) || 'Image not found.' };
};

const applyImage = (img, val) => {
  if (val && val.src) {
    img.src = val.src;
    return;
  }
  const span = document.createElement('span');
  span.className = 'img-missing';
  span.textContent = `🖼 ${img.getAttribute('data-embed') || img.getAttribute('data-local') || ''} — ${
    (val && val.error) || 'not found'
  }`;
  img.replaceWith(span);
};

const onPreviewClick = (ev) => {
  const a = ev.target.closest('a');
  if (!a || !el.preview.contains(a)) return;
  ev.preventDefault();
  const tag = a.getAttribute('data-tag');
  if (tag !== null) {
    const v = vaultName();
    if (v) openExternal(`obsidian://search?vault=${encodeURIComponent(v)}&query=${encodeURIComponent(`tag:#${tag}`)}`);
    else snack('Set your vault folder in ⋯ → Settings to search tags in Obsidian.', 'WARNING');
    return;
  }
  const wiki = a.getAttribute('data-wikilink');
  if (wiki !== null) {
    const uri = obsidianWikiUri(vaultName(), wiki || (S.file && S.file.rel ? S.file.rel.replace(/\.md$/i, '') : ''));
    if (uri) openExternal(uri);
    else snack('Set your vault folder in ⋯ → Settings to open wikilinks.', 'WARNING');
    return;
  }
  const href = a.getAttribute('href') || '';
  if (!href || href.startsWith('#')) return;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    openExternal(href);
    return;
  }
  if (S.file && S.file.rel && /\.md(#.*)?$/i.test(href)) {
    const target = resolveRelPosix(S.file.rel, safeDecode(href.replace(/#.*$/, '')));
    const uri = target && obsidianOpenUri({ vault: vaultName(), rel: target });
    if (uri) openExternal(uri);
  }
};

const onPreviewChange = (ev) => {
  const cb = ev.target;
  if (!(cb instanceof HTMLInputElement) || cb.type !== 'checkbox' || cb.dataset.taskIndex === undefined) return;
  const next = toggleTask(S.buffer, Number(cb.dataset.taskIndex), cb.checked);
  if (next === S.buffer) {
    renderPreview();
    return;
  }
  S.buffer = next;
  const { selectionStart: s, selectionEnd: e } = el.editor;
  el.editor.value = next;
  el.editor.setSelectionRange(s, e);
  markDirty(300);
};

// ---------- Link picker ----------

const ensureScan = async (force = false) => {
  if (!S.root) return { md: [], img: [], truncated: false };
  if (!force && S.scan && S.scan.root === S.root) return S.scan;
  const r = await runNode(SCRIPT_SCAN, [S.root, MAX_SCAN_ENTRIES], 30000);
  S.scan = { root: S.root, md: r.md || [], img: r.img || [], truncated: !!r.truncated };
  S.tree = null;
  return S.scan;
};

const openLinkView = async (changing) => {
  S.linkChanging = changing;
  el.linkTitle.textContent = `${changing ? 'Change the file linked to' : 'Link a markdown file to'} “${
    S.projectTitle
  }”`;
  el.btnLinkCancel.hidden = !(changing && S.link);
  el.linkError.textContent = '';
  el.linkPath.value = '';
  el.linkSearch.value = '';
  showView('link');
  if (!S.root) {
    el.linkBrowse.hidden = true;
    el.linkNoRoot.hidden = false;
    return;
  }
  el.linkBrowse.hidden = false;
  el.linkNoRoot.hidden = true;
  await refreshLinkList(false);
};

const refreshLinkList = async (force) => {
  el.scanInfo.textContent = 'Scanning…';
  el.linkTree.innerHTML = '';
  try {
    await ensureScan(force);
  } catch (e) {
    el.scanInfo.textContent = '';
    if (isPermissionError(e)) showNodeError(e);
    else el.linkError.textContent = `Could not scan the folder: ${e.message || e}`;
    return;
  }
  const n = S.scan.md.length;
  el.scanInfo.textContent = `${n} note${n === 1 ? '' : 's'}${S.scan.truncated ? ' (folder too large; list is partial)' : ''}`;
  renderLinkList();
};

const fileButton = (rel, showPath) => {
  const b = document.createElement('button');
  b.className = 'file-btn';
  b.type = 'button';
  const name = rel.slice(rel.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  b.textContent = name;
  if (showPath && rel.includes('/')) {
    const small = document.createElement('small');
    small.textContent = rel.slice(0, rel.lastIndexOf('/'));
    b.appendChild(small);
  }
  b.title = rel;
  b.addEventListener('click', () => linkTo({ rel }));
  return b;
};

const groupTitle = (text) => {
  const d = document.createElement('div');
  d.className = 'group-title';
  d.textContent = text;
  return d;
};

const renderDir = (node, container) => {
  const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const d of dirs) {
    const det = document.createElement('details');
    const sum = document.createElement('summary');
    sum.textContent = `📁 ${d.name}`;
    const inner = document.createElement('div');
    det.append(sum, inner);
    det.addEventListener('toggle', () => {
      if (det.open && !inner.childElementCount) renderDir(d, inner);
    });
    container.appendChild(det);
  }
  for (const f of [...node.files].sort((a, b) => a.localeCompare(b))) container.appendChild(fileButton(f, false));
};

const renderLinkList = () => {
  if (!S.scan) return;
  const q = el.linkSearch.value;
  el.linkTree.innerHTML = '';
  if (q.trim()) {
    const hits = searchNotes(S.scan.md, q);
    if (!hits.length) el.linkTree.appendChild(groupTitle('No matching notes'));
    for (const h of hits) el.linkTree.appendChild(fileButton(h, true));
    return;
  }
  const sugg = suggestForProject(S.scan.md, S.projectTitle);
  if (sugg.length) {
    el.linkTree.appendChild(groupTitle('Suggested'));
    for (const s of sugg) el.linkTree.appendChild(fileButton(s, true));
    el.linkTree.appendChild(groupTitle('All notes'));
  }
  if (!S.tree) S.tree = buildTree(S.scan.md);
  renderDir(S.tree, el.linkTree);
};

const linkTo = async (link) => {
  el.linkError.textContent = '';
  const pid = S.projectId;
  if (!pid) return;
  const label = escapeHtml(link.rel || link.abs);
  if (S.linkChanging && S.link) {
    const ok = await confirmDialog(
      'Change linked file?',
      `<p>Link <b>${escapeHtml(S.projectTitle)}</b> to <b>${label}</b> instead?</p><p class="hint">Nothing is deleted; the old file stays where it is.</p>`,
      'Change',
    );
    if (!ok) return;
  }
  await flushSave();
  const value = { ...link };
  try {
    await updateStore((d) => {
      d.links[pid] = value;
    });
  } catch (e) {
    el.linkError.textContent = `Could not save the link: ${e.message || e}`;
    return;
  }
  if (pid !== S.projectId) return;
  S.link = value;
  const seq = ++S.loadSeq;
  resetFile();
  S.link = value;
  await openLinkedFile(seq);
};

const linkPastedPath = async () => {
  el.linkError.textContent = '';
  let r;
  try {
    r = await runNode(SCRIPT_RESOLVE_LINK, [S.root, el.linkPath.value]);
  } catch (e) {
    el.linkError.textContent = String(e.message || e);
    return;
  }
  if (r.error) {
    el.linkError.textContent = r.error;
    return;
  }
  if (r.rel) {
    await linkTo({ rel: r.rel });
  } else {
    await linkTo({ abs: r.abs, host: S.host });
    snack(
      S.root
        ? 'Linked by full path (outside your vault folder): it will only open on this computer.'
        : 'Linked by full path: set a vault folder in Settings so the link also works on your other computers.',
      'WARNING',
    );
  }
};

// ---------- Menu ----------

const closeMenu = () => {
  el.menu.hidden = true;
};

const toggleMenu = () => {
  const hasFile = !!S.file;
  const hasLink = !!S.link;
  el.menu.querySelector('[data-act="open-obsidian"]').hidden = !hasFile;
  el.menu.querySelector('[data-act="reload"]').hidden = !hasFile;
  el.menu.querySelector('[data-act="unlink"]').hidden = !hasLink || S.mode === 'daily';
  el.menu.querySelector('[data-act="change"]').hidden = !S.projectId || S.mode === 'daily';
  el.menu.hidden = !el.menu.hidden;
};

const onMenuAction = async (act) => {
  closeMenu();
  if (act === 'settings') return openSettings();
  if (act === 'change') return openLinkView(true);
  if (act === 'open-obsidian' && S.file) {
    return openExternal(obsidianOpenUri({ vault: vaultName(), rel: S.file.rel, abs: S.file.abs }));
  }
  if (act === 'reload' && S.file) {
    if (S.dirty) {
      const ok = await confirmDialog(
        'Reload from disk?',
        '<p>Your unsaved edits will be discarded.</p>',
        'Reload',
      );
      if (!ok) return;
    }
    try {
      const r = await runNode(SCRIPT_READ, [S.file.abs, MAX_NOTE_BYTES]);
      if (r.exists && !r.tooLarge) applyRemote(r.content, r.mtimeMs);
      else setStatus('File missing', true);
    } catch (e) {
      showNodeError(e);
    }
    return;
  }
  if (act === 'unlink' && S.link) {
    const ok = await confirmDialog(
      'Unlink file?',
      `<p>Remove the link between <b>${escapeHtml(S.projectTitle)}</b> and <b>${escapeHtml(
        S.link.rel || S.link.abs,
      )}</b>?</p><p class="hint">The file itself is not touched.</p>`,
      'Unlink',
    );
    if (!ok) return;
    await flushSave();
    const pid = S.projectId;
    try {
      await updateStore((d) => {
        delete d.links[pid];
      });
    } catch (e) {
      snack(`Could not unlink: ${e.message || e}`, 'ERROR');
      return;
    }
    S.loadSeq++;
    resetFile();
    renderHeader();
    await openLinkView(false);
  }
};

// ---------- Wiring ----------

const setEditing = (editing) => {
  S.editing = editing;
  applyLayout();
  if (editing) el.editor.focus();
};

const wireUi = () => {
  el.modeSeg.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-mode]');
    if (b) setEditing(b.dataset.mode !== 'preview');
  });
  el.btnExpand.textContent = IS_FULL_PAGE ? '⤡' : '⤢';
  el.btnExpand.title = IS_FULL_PAGE ? 'Exit full page' : 'Open as full page';
  el.btnExpand.setAttribute('aria-label', el.btnExpand.title);
  el.btnExpand.addEventListener('click', async () => {
    if (IS_FULL_PAGE) {
      await exitFullPage();
      return;
    }
    await flushSave();
    try {
      await api().showIndexHtmlAsView();
    } catch {
      /* ignore */
    }
  });
  el.btnMenu.addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggleMenu();
  });
  el.menu.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-act]');
    if (b) onMenuAction(b.dataset.act);
  });
  document.addEventListener('click', (ev) => {
    if (!el.menu.hidden && !el.menu.contains(ev.target) && ev.target !== el.btnMenu) closeMenu();
  });
  el.projSelect.addEventListener('change', () => {
    S.manualProjectId = el.projSelect.value || null;
    selectProject(S.manualProjectId, projectTitle(S.manualProjectId));
  });
  el.btnSaveSettings.addEventListener('click', saveSettings);
  $('btnExport').addEventListener('click', exportSettings);
  $('btnImport').addEventListener('click', importSettings);
  el.btnSettingsBack.addEventListener('click', reopenProject);
  el.lnkOpenSettings.addEventListener('click', (ev) => {
    ev.preventDefault();
    openSettings();
  });
  let searchTimer = null;
  el.linkSearch.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderLinkList, 120);
  });
  el.btnRescan.addEventListener('click', () => refreshLinkList(true));
  el.btnLinkPath.addEventListener('click', linkPastedPath);
  el.linkPath.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') linkPastedPath();
  });
  el.btnLinkCancel.addEventListener('click', reopenProject);

  el.editor.addEventListener('input', () => {
    S.buffer = el.editor.value;
    markDirty();
    schedulePreview();
  });
  el.editor.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      save(true);
    } else if (ev.key === 'Tab' && !ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      ev.preventDefault();
      el.editor.setRangeText('\t', el.editor.selectionStart, el.editor.selectionEnd, 'end');
      el.editor.dispatchEvent(new Event('input'));
    } else if (ev.key === 'Escape' && !isWide()) {
      setEditing(false);
    }
  });
  el.editor.addEventListener('blur', () => {
    if (S.dirty) save();
  });
  el.preview.addEventListener('click', onPreviewClick);
  el.preview.addEventListener('change', onPreviewChange);

  window.addEventListener('resize', () => {
    if (S.view === 'note') applyLayout();
  });
  window.addEventListener('focus', () => {
    S.noteCache.clear();
    checkExternal();
  });
  // In-panel shortcut: Cmd/Ctrl+E switches Preview and Edit/Split.
  document.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === 'e' && S.view === 'note') {
      ev.preventDefault();
      setEditing(!S.editing);
    }
  });
  // Commands from plugin.js (keyboard shortcuts registered with the app).
  window.__projectMarkdownNote = true;
  window.addEventListener('message', (ev) => {
    const cmd = ev.data && ev.data.projectMarkdownNote;
    if (!cmd || ev.source !== window.parent) return;
    if (cmd === 'toggle-edit' && S.view === 'note') setEditing(!S.editing);
    else if (cmd === 'exit-full-page' && IS_FULL_PAGE) exitFullPage();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) save();
    else checkExternal();
  });
  window.addEventListener('pagehide', () => {
    if (S.dirty) save();
  });
  setInterval(checkExternal, POLL_MS);
  setInterval(pollContext, 1000);
};

// Older hosts have no getActiveWorkContext(): read the app's route instead
// (the iframe is same-origin, and the app uses hash routing on every platform).
// Returns a context, null for non-work pages, or undefined if unreadable.
const parseRoute = () => {
  let h;
  try {
    h = window.parent.location.hash || '';
  } catch {
    return undefined;
  }
  let m = /^#\/project\/([^/?#]+)/.exec(h);
  if (m) return { type: 'PROJECT', id: decodeURIComponent(m[1]) };
  m = /^#\/tag\/([^/?#]+)/.exec(h);
  if (m) {
    const id = decodeURIComponent(m[1]);
    return { type: id === 'TODAY' ? 'TODAY' : 'TAG', id };
  }
  return null;
};

const withTitle = async (ctx) => {
  if (!ctx) return ctx;
  if (ctx.type === 'PROJECT') {
    if (!projectTitle(ctx.id)) await refreshProjects();
    return { ...ctx, title: projectTitle(ctx.id) || 'Project' };
  }
  return { ...ctx, title: ctx.type === 'TODAY' ? 'Today' : 'Tag view' };
};

const LAST_PROJECT_KEY = 'project-markdown-note:lastProject';
const rememberProject = (id) => {
  try {
    localStorage.setItem(LAST_PROJECT_KEY, id);
  } catch {
    /* best effort */
  }
};
const lastProject = () => {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
};

// Backstop poll: catches project switches when the hook is missing (or in route mode).
let pollingCtx = false;
const pollContext = async () => {
  const a = api();
  if (!S.autoFollow || pollingCtx || document.hidden || !a) return;
  pollingCtx = true;
  try {
    let ctx;
    if (S.ctxMode === 'api') ctx = await a.getActiveWorkContext();
    else if (S.ctxMode === 'route') ctx = await withTitle(parseRoute());
    if (ctx && (!S.ctx || ctx.id !== S.ctx.id)) await onContext(ctx);
    else if (S.mode === 'daily' && S.dailyKey !== todayKey() && !S.dirty) await selectDaily(true);
  } catch {
    /* ignore */
  } finally {
    pollingCtx = false;
  }
};

const onPersistedChanged = async () => {
  const oldRoot = S.root;
  const oldVault = S.vault;
  const oldDaily = JSON.stringify(S.daily);
  const d = await loadSettings();
  if (S.root !== oldRoot) {
    S.scan = null;
    S.tree = null;
  }
  if (S.view === 'settings') return;
  if (S.mode === 'daily') {
    if (!S.dirty && (S.root !== oldRoot || JSON.stringify(d.daily) !== oldDaily)) await selectDaily(true);
    return;
  }
  if (!S.projectId) return;
  const valid = validLink(d.links[S.projectId]);
  const changed = JSON.stringify(valid) !== JSON.stringify(S.link) || S.root !== oldRoot;
  if (changed && !S.dirty) await reopenProject();
  else if (S.vault !== oldVault) renderHeader();
};

const init = async () => {
  wireUi();
  const a = api();
  if (!a) {
    showMessage('<p>The Super Productivity plugin API is not available.</p>');
    return;
  }
  if ((a.cfg && a.cfg.platform && a.cfg.platform !== 'desktop') || typeof a.executeNodeScript !== 'function') {
    showMessage(
      '<p>Project Markdown Note needs the Super Productivity <b>desktop app</b>, because it reads and writes files on your computer.</p>',
    );
    return;
  }
  showMessage('<p class="hint">Loading…</p>');
  let info;
  try {
    info = await runNode(SCRIPT_INFO);
  } catch (e) {
    showNodeError(e);
    return;
  }
  S.host = info.host;
  S.sep = info.sep || '/';
  const stored = await loadSettings();
  try {
    const b = await runNode(SCRIPT_BACKUP, ['read']);
    if (!hasContent(stored) && b.exists) {
      const parsed = JSON.parse(b.content);
      if (hasContent(parsed)) {
        await replaceStore(parsed);
        await loadSettings();
        snack('Restored your folders and project links from the local backup', 'SUCCESS');
      }
    } else if (hasContent(stored)) {
      writeBackup(stored);
    }
  } catch {
    /* backup is best effort */
  }
  await refreshProjects();
  const hooks = a.Hooks || {};
  const persistHook = hooks.PERSISTED_DATA_CHANGED || hooks.PERSISTED_DATA_UPDATE;
  if (persistHook) Promise.resolve(a.registerHook(persistHook, onPersistedChanged)).catch(() => {});
  const route = parseRoute();
  if (typeof a.getActiveWorkContext === 'function') {
    S.ctxMode = 'api';
    S.autoFollow = true;
    Promise.resolve(
      a.registerHook(hooks.WORK_CONTEXT_CHANGE || 'workContextChange', (ctx) => {
        onContext(ctx);
      }),
    ).catch(() => {});
    let ctx = null;
    try {
      ctx = await a.getActiveWorkContext();
    } catch {
      ctx = null;
    }
    await onContext(ctx);
  } else if (route !== undefined) {
    S.ctxMode = 'route';
    S.autoFollow = true;
    const last = lastProject();
    let ctx = await withTitle(route);
    if (!ctx && last && projectTitle(last)) ctx = { type: 'PROJECT', id: last, title: projectTitle(last) };
    await onContext(ctx);
  } else {
    S.ctxMode = 'manual';
    S.autoFollow = false;
    await onContext(null);
  }
};

init().catch((e) => {
  showMessage(`<p>Something went wrong while starting.</p><p class="hint">${escapeHtml(e && e.message)}</p>`);
});
