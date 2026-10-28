import json, os, pathlib, struct, subprocess, sys, tempfile, time, zlib
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
DIST = pathlib.Path(sys.argv[1])
OUT = pathlib.Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)

def png(w=40, h=24, rgb=(63, 81, 181)):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")

tmp = pathlib.Path(tempfile.mkdtemp(prefix="pmn-h-"))
vault = tmp / "Work Vault"
(vault / "Projects" / "img").mkdir(parents=True)
(vault / "attachments").mkdir()
(vault / "Projects" / "img" / "pic.png").write_bytes(png())
(vault / "attachments" / "diagram.png").write_bytes(png(rgb=(233, 30, 99)))
alpha = vault / "Projects" / "Alpha.md"
alpha.write_text("""---
status: active
---
# Alpha

Kick-off notes with a [[Projects/Beta|Beta link]] and [web](https://example.com).

- [ ] Draft outline
- [x] Book room
- [ ] Email Dr Dinesh

> [!tip] Remember
> Callout body with #callout-tag

Tagged #project/alpha here.

![[Embedded#Part]]

![[diagram.png]]

![local](img/pic.png)

<img src=x onerror="window.__xss=1">

```
- [ ] code, not a task
```
""")
(vault / "Notes").mkdir()
(vault / "Notes" / "Embedded.md").write_text("# Embedded\n## Part\nEmbedded part text\n- [ ] embedded task\n## Other\nnot shown\n")
(vault / ".obsidian").mkdir()
(vault / ".obsidian" / "daily-notes.json").write_text(json.dumps({"folder": "Daily", "format": "YYYY-MM-DD", "template": "Templates/Daily"}))
(vault / "Templates").mkdir()
(vault / "Templates" / "Daily.md").write_text("# {{title}}\n\n## Log\n- [ ] Review {{date:dddd}}\n")
fake_home = tmp / "home"
fake_home.mkdir()
(vault / "Areas").mkdir()
(vault / "Areas" / "Health.md").write_text("# Health\n")
outside = tmp / "outside" / "Beta notes.md"
outside.parent.mkdir()
outside.write_text("# Beta\nOutside the vault.\n")

def run_node(req_json):
    req = json.loads(req_json)
    p = subprocess.run(["node", str(HERE / "runner.mjs")], input=json.dumps({"script": req["script"], "args": req.get("args", [])}),
                       capture_output=True, text=True, timeout=30, env={**os.environ, "HOME": str(fake_home)})
    return p.stdout or json.dumps({"success": False, "error": p.stderr[-300:]})

html = (DIST / "index.html").read_text()
mock = (HERE / "mock-api.js").read_text()
i = html.lower().find("<script") if len(sys.argv) > 3 and sys.argv[3] == "early" else html.lower().rfind("</body>")
plugin_js = (DIST / "plugin.js").read_text()
page_html = html[:i] + "<script>" + mock + "</script><script>" + plugin_js + "</script>" + html[i:]

results = []
def check(name, cond):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name, flush=True)

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 380, "height": 760})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.expose_function("__runNode", run_node)
    page.set_content(page_html)
    vis = lambda sel: page.is_visible(sel)

    page.wait_for_selector("#viewLink:not([hidden])", timeout=15000)
    check("no link -> link view", vis("#viewLink"))
    check("no root -> browse hidden, hint shown", vis("#linkNoRoot") and not vis("#linkBrowse"))
    page.screenshot(path=str(OUT / "01-link-noroot.png"))

    # Settings: set the vault root for this computer.
    page.click("#lnkOpenSettings")
    page.fill("#rootInput", str(vault) + "/")
    page.click("#btnSaveSettings")
    page.wait_for_selector("#linkBrowse:not([hidden])", timeout=15000)
    page.wait_for_function("document.querySelectorAll('#linkTree .file-btn').length > 0", timeout=15000)
    blob = lambda: json.loads(page.evaluate("window.__store")["__default"])
    check("root saved per host", list(blob()["roots"].values()) == [str(vault)])
    check("suggested Alpha.md", "Suggested" in page.inner_text("#linkTree") and "Alpha" in page.inner_text("#linkTree"))
    page.fill("#linkSearch", "heal")
    page.wait_for_function("document.querySelector('#linkTree').innerText.includes('Health')")
    check("search finds Health", "Health" in page.inner_text("#linkTree"))
    page.fill("#linkSearch", "")
    page.wait_for_function("document.querySelector('#linkTree').innerText.includes('Suggested')")
    page.screenshot(path=str(OUT / "02-link-tree.png"))
    page.click("#linkTree .file-btn >> nth=0")
    page.wait_for_selector("#viewNote:not([hidden])", timeout=15000)
    check("link stored relative", blob()["links"]["p-alpha"] == {"rel": "Projects/Alpha.md"})

    # Preview rendering.
    page.wait_for_function("document.querySelectorAll('#preview img[src^=\"data:image/png\"]').length === 2", timeout=15000)
    page.wait_for_function("document.querySelector('#preview .mn-embed-body') && document.querySelector('#preview .mn-embed-body').innerText.includes('Embedded part text')", timeout=15000)
    check("embedded note section shown, other section not", "not shown" not in page.inner_text("#preview .mn-embed-body"))
    check("embedded checkbox is read-only", page.evaluate("document.querySelector('#preview .mn-embed input[type=checkbox]').disabled"))
    check("callout rendered", page.evaluate("!!document.querySelector('#preview .callout.callout-teal .callout-title')"))
    check("tags rendered", page.evaluate("[...document.querySelectorAll('#preview a.tag')].map(a => a.dataset.tag).join(',')") == "callout-tag,project/alpha")
    prev = page.inner_html("#preview")
    check("frontmatter hidden", "status: active" not in page.inner_text("#preview"))
    check("3 note checkboxes (code block and embed excluded)", page.evaluate("document.querySelectorAll('#preview input[data-task-index]').length") == 3)
    check("wikilink rendered", 'data-wikilink="Projects/Beta"' in prev)
    check("embedded + local images loaded", True)
    check("xss stripped", page.evaluate("window.__xss") is None and page.evaluate("document.querySelectorAll('#preview img[onerror], #preview script').length") == 0 and "&lt;img src=x" in prev)
    check("header shows project + file", page.inner_text("#projName") == "Alpha" and page.inner_text("#fileName") == "Projects/Alpha.md")
    page.screenshot(path=str(OUT / "03-preview-panel.png"), full_page=True)

    # Clicking a checkbox writes the file.
    page.click("#preview input[data-task-index='2']")
    deadline = time.time() + 6
    while time.time() < deadline and "- [x] Email Dr Dinesh" not in alpha.read_text():
        page.wait_for_timeout(100)
    check("checkbox toggle saved", "- [x] Email Dr Dinesh" in alpha.read_text() and "- [ ] code, not a task" in alpha.read_text())
    page.wait_for_function("document.querySelector('#status').textContent === 'Saved'", timeout=5000)

    # Wikilink opens Obsidian URI.
    page.click("#preview p a.wikilink")
    check("wikilink -> obsidian uri", page.evaluate("window.__opened")[-1] == "obsidian://open?vault=Work%20Vault&file=Projects%2FBeta")
    page.click("#preview a.tag >> nth=1")
    check("tag -> obsidian search", page.evaluate("window.__opened")[-1] == "obsidian://search?vault=Work%20Vault&query=tag%3A%23project%2Falpha")
    sc = page.evaluate("Object.keys(window.__shortcuts || {}).sort().join(',')")
    check("3 shortcuts registered", sc == "toggle-edit,toggle-full-page,toggle-panel")
    page.evaluate("window.postMessage({projectMarkdownNote: 'toggle-edit'}, '*')")
    page.wait_for_function("!document.querySelector('#editor').hidden", timeout=3000)
    page.keyboard.press("Control+e")
    page.wait_for_function("document.querySelector('#editor').hidden", timeout=3000)
    check("shortcut message and Ctrl+E toggle edit", True)

    # Edit mode (narrow): raw editor only, autosave.
    check("narrow shows Preview/Edit, not Split", vis("#modeSeg [data-mode=edit]") and not vis("#modeSeg [data-mode=split]"))
    page.click("#modeSeg [data-mode=edit]")
    check("edit mode hides preview", vis("#editor") and not vis("#preview"))
    page.click("#editor")
    page.keyboard.press("Control+End")
    page.keyboard.type("\nAdded from SP")
    check("status unsaved while typing", page.inner_text("#status") in ("Unsaved", "Saving…"))
    deadline = time.time() + 6
    while time.time() < deadline and "Added from SP" not in alpha.read_text():
        page.wait_for_timeout(100)
    check("autosave wrote edit", alpha.read_text().endswith("Added from SP"))
    page.screenshot(path=str(OUT / "04-edit-panel.png"))

    # External change while clean -> silent reload.
    page.wait_for_function("document.querySelector('#status').textContent === 'Saved'", timeout=5000)
    page.wait_for_timeout(50)
    alpha.write_text(alpha.read_text() + "\nFrom Obsidian")
    page.evaluate("window.dispatchEvent(new Event('focus'))")
    page.wait_for_function("document.querySelector('#editor').value.endsWith('From Obsidian')", timeout=8000)
    check("external edit reloaded", True)

    # External change while dirty -> conflict dialog, keep mine.
    page.click("#editor")
    page.keyboard.press("Control+End")
    page.keyboard.type("\nMine")
    alpha.write_text("CONFLICTING EXTERNAL")
    os.utime(alpha, (time.time() + 5, time.time() + 5))
    page.wait_for_selector("#modal:not([hidden])", timeout=10000)
    page.screenshot(path=str(OUT / "05b-conflict.png"))
    check("conflict dialog shown", "changed" in page.inner_text("#modal"))
    page.click("#modalButtons button:has-text('Keep mine')")
    deadline = time.time() + 6
    while time.time() < deadline and not alpha.read_text().endswith("Mine"):
        page.wait_for_timeout(100)
    check("keep mine overwrote file", alpha.read_text().endswith("From Obsidian\nMine"))

    # Conflict -> use file.
    page.wait_for_function("document.querySelector('#status').textContent === 'Saved'", timeout=6000)
    page.keyboard.type("\nThrowaway")
    alpha.write_text("FILE WINS")
    os.utime(alpha, (time.time() + 10, time.time() + 10))
    page.wait_for_selector("#modal:not([hidden])", timeout=10000)
    page.click("#modalButtons button:has-text('Use file')")
    page.wait_for_function("document.querySelector('#editor').value === 'FILE WINS'", timeout=10000)
    page.wait_for_timeout(1500)
    check("use file loaded file version", alpha.read_text() == "FILE WINS")

    # Switch project via hook -> Beta has no link; paste outside path.
    page.evaluate("window.__ctx = {id:'p-beta', type:'PROJECT', title:'Beta', taskIds:[]}; window.__fireHook('workContextChange', window.__ctx)")
    page.wait_for_selector("#viewLink:not([hidden])", timeout=8000)
    check("context change -> Beta link view", "Beta" in page.inner_text("#linkTitle"))
    page.fill("#linkPath", str(outside))
    page.click("#btnLinkPath")
    page.wait_for_selector("#viewNote:not([hidden])", timeout=8000)
    beta_link = blob()["links"]["p-beta"]
    check("outside path stored absolute with host", beta_link.get("abs") == str(outside) and beta_link.get("host"))
    check("warning snack for outside link", any("full path" in (s.get("msg") or "") for s in page.evaluate("window.__snacks")))

    # Today view -> daily note (settings detected from .obsidian/daily-notes.json).
    page.evaluate("window.__ctx = {id:'TODAY', type:'TODAY', title:'Today', taskIds:[]}; window.__fireHook('workContextChange', window.__ctx)")
    page.wait_for_selector("#viewMessage:not([hidden])", timeout=8000)
    page.wait_for_function("document.querySelector('#viewMessage').innerText.includes('No daily note')", timeout=8000)
    today = time.strftime("%Y-%m-%d")
    check("today: offers to create daily note at the Obsidian path", f"Daily/{today}.md" in page.inner_text("#viewMessage"))
    page.click("#viewMessage button:has-text(\"Create today's note\")")
    page.wait_for_selector("#viewNote:not([hidden])", timeout=8000)
    daily = vault / "Daily" / f"{today}.md"
    check("daily note created from template", daily.exists() and daily.read_text().startswith(f"# {today}\n\n## Log\n- [ ] Review {time.strftime('%A')}"))
    check("daily header", page.inner_text("#projName").startswith("Today") and page.inner_text("#fileName") == f"Daily/{today}.md")
    page.screenshot(path=str(OUT / "05a-daily.png"))

    # Tag view -> dropdown.
    page.evaluate("window.__ctx = {id:'tag-1', type:'TAG', title:'Urgent', taskIds:[]}; window.__fireHook('workContextChange', window.__ctx)")
    page.wait_for_selector("#projSelect:not([hidden])", timeout=8000)
    opts = page.eval_on_selector_all("#projSelect option", "els => els.map(e => e.textContent)")
    check("tag view shows project dropdown without archived", opts == ["— Choose project —", "Alpha", "Beta"])
    page.select_option("#projSelect", "p-alpha")
    page.wait_for_function("document.querySelector('#editor').value === 'FILE WINS'", timeout=8000)
    check("manual pick opens Alpha", True)
    page.screenshot(path=str(OUT / "05-today-dropdown.png"))

    # Wide (full-page) -> Split.
    page.evaluate("window.__ctx = {id:'p-alpha', type:'PROJECT', title:'Alpha', taskIds:[]}; window.__fireHook('workContextChange', window.__ctx)")
    alpha.write_text("# Alpha\n\nSplit view test\n\n- [ ] one\n\n![[diagram.png|120]]\n")
    page.evaluate("window.dispatchEvent(new Event('focus'))")
    page.set_viewport_size({"width": 1100, "height": 700})
    page.wait_for_function("document.querySelector('#editor').value.includes('Split view test')", timeout=8000)
    check("back on project hides dropdown", not vis("#projSelect") and page.inner_text("#projName") == "Alpha")
    check("wide shows Split, hides Edit", vis("#modeSeg [data-mode=split]") and not vis("#modeSeg [data-mode=edit]"))
    page.click("#modeSeg [data-mode=split]")
    check("split shows editor + preview", vis("#editor") and vis("#preview") and page.evaluate("document.querySelector('#noteWrap').classList.contains('split')"))
    page.click("#editor")
    page.keyboard.press("Control+End")
    page.keyboard.type("\n## Live")
    page.wait_for_function("document.querySelector('#preview').innerHTML.includes('<h2>Live</h2>')", timeout=4000)
    check("split live preview", True)
    page.wait_for_function("document.querySelectorAll('#preview img[src^=\"data:\"]').length === 1", timeout=8000)
    page.screenshot(path=str(OUT / "06-split-fullpage.png"))

    # Menu: unlink with confirm.
    page.click("#btnMenu")
    page.click("#menu [data-act=unlink]")
    page.click("#modalButtons button:has-text('Unlink')")
    page.wait_for_selector("#viewLink:not([hidden])", timeout=8000)
    check("unlink clears link, file untouched", "p-alpha" not in blob()["links"] and "p-beta" in blob()["links"] and alpha.exists())

    # Local backup follows every change; a fresh install restores from it.
    page.wait_for_timeout(1500)
    backup = fake_home / ".sp-project-markdown-note.json"
    bk = json.loads(backup.read_text()) if backup.exists() else {}
    check("backup file mirrors settings", "p-beta" in bk.get("links", {}) and "p-alpha" not in bk.get("links", {}))
    page2 = b.new_page(viewport={"width": 380, "height": 760})
    page2.on("pageerror", lambda e: errors.append(str(e)))
    page2.expose_function("__runNode", run_node)
    page2.set_content(page_html.replace("title: 'Alpha', taskIds: [] };", "title: 'Alpha', taskIds: [] }; window.__ctx = { id: 'p-beta', type: 'PROJECT', title: 'Beta', taskIds: [] };", 1))
    page2.wait_for_selector("#viewNote:not([hidden])", timeout=15000)
    check("fresh install restores links from backup", "Outside the vault" in page2.evaluate("document.querySelector('#editor').value")
          and any("backup" in (s.get("msg") or "") for s in page2.evaluate("window.__snacks")))
    page2.close()

    check("no page errors", not errors)
    if errors:
        print(errors)
    b.close()

failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
