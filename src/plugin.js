// Project Markdown Note: host-side part. The UI lives in index.html.
// 1. Shares the markdown library with the iframes (they are same-origin), so the
//    UI bundle stays under the 100 KB index.html cap of released app versions.
// 2. Registers keyboard shortcuts; pick the keys in Settings -> Keyboard
//    shortcuts -> Plugin shortcuts. Commands reach the iframes via postMessage.
import { Marked } from 'marked';

window.__projectMarkdownNoteLib = { Marked, version: 1 };

const PANEL_LABEL = 'Project Markdown Note';

const ownFrames = () =>
  Array.from(document.querySelectorAll('iframe')).filter((f) => {
    try {
      return !!(f.contentWindow && f.contentWindow.__projectMarkdownNote);
    } catch (e) {
      return false;
    }
  });

const isFullPage = () => /^#\/plugins\/project-markdown-note\/index/.test(window.location.hash);

// Prefer the full-page view when it is showing, else the side panel.
const send = (cmd) => {
  const frames = ownFrames();
  const full = frames.find((f) => f.closest('.route-wrapper'));
  const targets = full ? [full] : frames;
  targets.forEach((f) => f.contentWindow.postMessage({ projectMarkdownNote: cmd }, '*'));
  return targets.length > 0;
};

const panelButton = () =>
  Array.from(document.querySelectorAll('button.plugin-side-panel-btn')).find((b) => {
    const label = [b.getAttribute('aria-label'), b.title, b.getAttribute('mattooltip')];
    const tipId = b.getAttribute('aria-describedby');
    const tip = tipId && document.getElementById(tipId);
    if (tip) label.push(tip.textContent);
    return label.some((t) => t && t.indexOf(PANEL_LABEL) !== -1);
  });

PluginAPI.registerShortcut({
  id: 'toggle-panel',
  label: 'Project note: show / hide side panel',
  onExec: () => {
    const b = panelButton();
    if (b) b.click();
    else PluginAPI.showSnack({ msg: 'Open a project first: the note panel button was not found.', type: 'WARNING' });
  },
});

PluginAPI.registerShortcut({
  id: 'toggle-full-page',
  label: 'Project note: full page on / off',
  onExec: () => {
    if (isFullPage()) {
      if (!send('exit-full-page')) window.history.back();
    } else {
      PluginAPI.showIndexHtmlAsView();
    }
  },
});

PluginAPI.registerShortcut({
  id: 'toggle-edit',
  label: 'Project note: Preview / Edit',
  onExec: () => {
    if (!send('toggle-edit')) {
      PluginAPI.showSnack({ msg: 'Open the project note first.', type: 'INFO' });
    }
  },
});
