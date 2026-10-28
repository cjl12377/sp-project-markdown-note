# Changelog

## 0.2.0 — 2026-10-28

- Daily note in the Today view, using Obsidian's daily-notes settings or your own; create today's note from a template.
- Embedded notes render inline: `![[Note]]`, `![[Note#Heading]]`, `![[Note#^block-id]]`, nested up to three levels.
- Obsidian callouts (including foldable) and clickable `#tags`.
- Keyboard shortcuts: show/hide panel, full page on/off, Preview/Edit (assign keys in the app); `Ctrl/⌘+E` inside the note.
- Settings are backed up to `~/.sp-project-markdown-note.json` and restored after a remove/reinstall; Export/Import settings.
- The markdown library now loads from `plugin.js`, leaving plenty of room under the 100 KB `index.html` limit.

## 0.1.4

- The full-page button toggles: ⤢ opens the full page, ⤡ goes back.

## 0.1.3

- Works on Super Productivity 18.x: one storage record, rate-limited saves, in-panel dialogs, route-based project detection, `index.html` under 100 KB, system font in the panel.

## 0.1.0

- First version: link a project to a markdown file; preview, edit, split; autosave with conflict guard; per-computer vault folders; wikilinks, images, task checkboxes.
