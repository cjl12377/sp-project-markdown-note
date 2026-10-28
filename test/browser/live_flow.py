"""End-to-end run on the public test app (a real Super Productivity host).

The web build has no Node bridge, so a test shim gives the plugin iframe an
executeNodeScript backed by a local Node runner; everything else (side panel,
routing, persistence, dialogs, full-page view) is the real host.
"""
import json, os, pathlib, struct, subprocess, sys, tempfile, time, zipfile, zlib
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
DIST = pathlib.Path(sys.argv[1])
OUT = pathlib.Path(sys.argv[2]); OUT.mkdir(parents=True, exist_ok=True)
APP = "https://test-app.super-productivity.com/"

# Web variant: same files, minus nodeExecution (web hosts refuse it).
variant = OUT / "web-variant.zip"
m = json.loads((DIST / "manifest.json").read_text())
m["permissions"] = [p for p in m["permissions"] if p != "nodeExecution"]
with zipfile.ZipFile(variant, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("manifest.json", json.dumps(m))
    for f in ("plugin.js", "index.html", "icon.svg"):
        z.write(DIST / f, f)

def png(w=60, h=30, rgb=(233, 30, 99)):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    ch = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + ch(b"IDAT", zlib.compress(raw)) + ch(b"IEND", b"")

tmp = pathlib.Path(tempfile.mkdtemp(prefix="pmn-live-"))
vault = tmp / "Work Vault"
(vault / "Projects").mkdir(parents=True)
(vault / "attachments").mkdir()
(vault / "attachments" / "diagram.png").write_bytes(png())
inbox_note = vault / "Projects" / "Inbox.md"
inbox_note.write_text("---\ntags: [sp]\n---\n# Inbox note\n\nLinked from **Super Productivity**. See [[Projects/Alpha|Alpha]].\n\n- [ ] First thing\n- [ ] Second thing\n\n![[diagram.png]]\n\n> [!warning] Heads up\n> Callout with #triage\n\n![[Alpha]]\n")
(vault / ".obsidian").mkdir()
(vault / ".obsidian" / "daily-notes.json").write_text(json.dumps({"folder": "Daily", "format": "YYYY-MM-DD"}))
fake_home = tmp / "home"
fake_home.mkdir()
alpha_note = vault / "Projects" / "Alpha.md"
alpha_note.write_text("# Alpha\n\nProject Alpha notes.\n")

def run_node(req_json):
    req = json.loads(req_json)
    p = subprocess.run(["node", str(HERE / "runner.mjs")], input=json.dumps({"script": req["script"], "args": req.get("args", [])}),
                       capture_output=True, text=True, timeout=30, env={**os.environ, "HOME": str(fake_home)})
    return p.stdout or json.dumps({"success": False, "error": p.stderr[-300:]})

results = []
def check(name, cond):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name, flush=True)

def wait_file(page, path, pred, secs=8):
    end = time.time() + secs
    while time.time() < end:
        if pred(path.read_text()):
            return True
        page.wait_for_timeout(100)
    return False

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1280, "height": 800})
    ctx.expose_function("__runNode", run_node)
    ctx.add_init_script(path=str(HERE / "shim.js"))
    page = ctx.new_page()
    errors = []
    logs = []
    page.on("console", lambda msg: logs.append(msg.text))
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" and "project-markdown-note" in msg.text else None)
    page.goto(APP, wait_until="networkidle", timeout=60000)
    page.wait_for_timeout(1500)
    page.get_by_text("Simple Todo List").click()
    page.wait_for_timeout(800)

    # Create a second project "Alpha".
    page.goto(APP + "#/project/INBOX_PROJECT/tasks", wait_until="networkidle")
    page.wait_for_timeout(800)
    page.mouse.click(242, 195)
    page.wait_for_timeout(1000)
    page.screenshot(path=str(OUT / "L0-add-project.png"))
    sidebar_add = page.is_visible("mat-dialog-container")
    inp = page.locator("mat-dialog-container input").first
    inp.fill("Alpha")
    page.locator("mat-dialog-container button[type=submit], mat-dialog-container button", has_text="Save").last.click()
    page.wait_for_timeout(1200)
    check("created Alpha project", bool(sidebar_add) and page.get_by_text("Alpha", exact=True).count() > 0)

    # Install + enable the plugin.
    page.goto(APP + "#/config", wait_until="networkidle")
    page.wait_for_timeout(1000)
    page.get_by_role("tab", name="Plugins").click()
    page.wait_for_timeout(800)
    page.set_input_files("input[type=file]", str(variant))
    page.wait_for_timeout(2000)
    page.locator("mat-card", has_text="project-markdown-note").locator("button[role=switch]").click()
    page.wait_for_timeout(1500)

    # Open the side panel in the Inbox project.
    page.goto(APP + "#/project/INBOX_PROJECT/tasks", wait_until="networkidle")
    page.wait_for_timeout(1000)
    page.locator("button.plugin-side-panel-btn").first.click()
    page.wait_for_timeout(2500)
    fr = lambda: [f for f in page.frames if f.url.startswith("blob:")][-1]
    f = fr()
    f.wait_for_selector("#viewLink:not([hidden])", timeout=15000)
    check("panel follows route: Inbox link view", "Inbox" in f.inner_text("#linkTitle"))
    page.screenshot(path=str(OUT / "L1-link-noroot.png"))

    f.click("#lnkOpenSettings")
    f.fill("#rootInput", str(vault))
    f.click("#btnSaveSettings")
    f.wait_for_function("document.querySelectorAll('#linkTree .file-btn').length > 0", timeout=15000)
    check("suggests Inbox.md for Inbox", "Suggested" in f.inner_text("#linkTree") and "Inbox" in f.inner_text("#linkTree"))
    f.click("#linkTree .file-btn >> nth=0")
    try:
        f.wait_for_selector("#viewNote:not([hidden])", timeout=15000)
    except Exception:
        page.screenshot(path=str(OUT / "ERR.png"))
        print("ERRVIEW", f.evaluate("[...document.querySelectorAll('main > section')].filter(x=>!x.hidden).map(x=>x.id+':'+x.innerText.slice(0,300))"))
        print("DIALOG", page.evaluate("[...document.querySelectorAll('mat-dialog-container')].map(d=>d.innerText)"))
        print("ERRS", errors[:5])
        raise
    f.wait_for_function("document.querySelectorAll('#preview img[src^=\"data:image/png\"]').length === 1", timeout=15000)
    check("preview renders (frontmatter hidden, 2 tasks, embed image)",
          "tags:" not in f.inner_text("#preview") and f.evaluate("document.querySelectorAll('#preview input[data-task-index]').length") == 2)
    check("plugin.js shared marked with the iframe", page.evaluate("!!(window.__projectMarkdownNoteLib && window.__projectMarkdownNoteLib.Marked)"))
    f.wait_for_function("document.querySelector('#preview .mn-embed-body') && document.querySelector('#preview .mn-embed-body').innerText.includes('Project Alpha notes')", timeout=15000)
    check("embedded note + callout + tag render on real host", f.evaluate("!!document.querySelector('#preview .callout-orange') && !!document.querySelector('#preview a.tag[data-tag=triage]')"))
    check("3 shortcuts registered with host", any("shortcuts" in l and "Array(3)" in l for l in logs))
    found = page.evaluate("""(() => { const b = [...document.querySelectorAll('button.plugin-side-panel-btn')].find(b => { const id = b.getAttribute('aria-describedby'); const t = id && document.getElementById(id); return t && t.textContent.includes('Project Markdown Note'); }); return !!b; })()""")
    check("shortcut can find the panel button", found)
    page.evaluate("[...document.querySelectorAll('iframe')].filter(f => f.contentWindow.__projectMarkdownNote).forEach(f => f.contentWindow.postMessage({projectMarkdownNote: 'toggle-edit'}, '*'))")
    f.wait_for_function("!document.querySelector('#editor').hidden", timeout=4000)
    page.evaluate("[...document.querySelectorAll('iframe')].filter(f => f.contentWindow.__projectMarkdownNote).forEach(f => f.contentWindow.postMessage({projectMarkdownNote: 'toggle-edit'}, '*'))")
    f.wait_for_function("document.querySelector('#editor').hidden", timeout=4000)
    check("shortcut command toggles Preview/Edit in the panel", True)
    page.screenshot(path=str(OUT / "L2-preview-panel.png"))

    # Persistence round-trip through the real host.
    stored = json.loads(f.evaluate("PluginAPI.loadSyncedData()"))
    check("real host stored link + root in one blob", stored["links"].get("INBOX_PROJECT") == {"rel": "Projects/Inbox.md"} and list(stored["roots"].values()) == [str(vault)])

    f.click("#preview input[type=checkbox] >> nth=1")
    check("checkbox writes file", wait_file(page, inbox_note, lambda t: "- [x] Second thing" in t))

    f.click("#modeSeg [data-mode=edit]")
    f.click("#editor")
    page.keyboard.press("Control+End")
    page.keyboard.type("\nTyped in SP")
    check("autosave writes file", wait_file(page, inbox_note, lambda t: t.endswith("Typed in SP")))
    page.screenshot(path=str(OUT / "L3-edit-panel.png"))

    # Conflict through the real dialog (18.x resolves via onClick).
    f.wait_for_function("document.querySelector('#status').textContent === 'Saved'", timeout=6000)
    page.keyboard.type("\nMine")
    inbox_note.write_text("EXTERNAL")
    os.utime(inbox_note, (time.time() + 5, time.time() + 5))
    f.wait_for_selector("#modal:not([hidden])", timeout=10000)
    page.screenshot(path=str(OUT / "L4-conflict-dialog.png"))
    check("conflict dialog shown in panel", "changed" in f.inner_text("#modal"))
    f.click("#modalButtons button:has-text('Keep mine')")
    check("keep mine via real dialog", wait_file(page, inbox_note, lambda t: t.endswith("Mine") and "Typed in SP" in t))

    # Project switch via sidebar -> panel follows (route mode).
    page.get_by_text("Alpha", exact=True).first.click()
    page.wait_for_timeout(2500)
    f = fr()
    f.wait_for_selector("#viewLink:not([hidden])", timeout=10000)
    check("switch to Alpha -> Alpha link view", "Alpha" in f.inner_text("#linkTitle"))
    f.fill("#linkSearch", "alpha")
    f.wait_for_function("document.querySelector('#linkTree').innerText.includes('Alpha')")
    f.click("#linkTree .file-btn >> nth=0")
    f.wait_for_selector("#viewNote:not([hidden])", timeout=10000)
    check("Alpha note opens", "Project Alpha notes" in f.evaluate("document.querySelector('#editor').value"))

    # Back to Inbox -> its own note.
    page.evaluate("location.hash = '#/project/INBOX_PROJECT/tasks'")
    page.wait_for_timeout(2500)
    f = fr()
    f.wait_for_function("document.querySelector('#editor').value.includes('Typed in SP')", timeout=10000)
    check("back to Inbox -> Inbox note", True)

    # Full page via the expand button.
    f.click("#btnExpand")
    page.wait_for_timeout(3000)
    f = fr()
    page.screenshot(path=str(OUT / "L5-fullpage.png"))
    f.wait_for_selector("#viewNote:not([hidden])", timeout=10000)
    check("full page opens with last project's note", "Typed in SP" in f.evaluate("document.querySelector('#editor').value"))
    check("full page offers Split", f.is_visible("#modeSeg [data-mode=split]"))
    f.click("#modeSeg [data-mode=split]")
    page.wait_for_timeout(500)
    page.screenshot(path=str(OUT / "L6-split.png"))
    check("full page shows exit toggle", f.inner_text("#btnExpand").strip() == "⤡" and f.get_attribute("#btnExpand", "title") == "Exit full page")
    f.click("#btnExpand")
    page.wait_for_timeout(2500)
    check("exit returns to the project route", page.evaluate("location.hash").startswith("#/project/INBOX_PROJECT"))
    page.screenshot(path=str(OUT / "L7-after-exit.png"))
    page.locator("button.plugin-side-panel-btn").first.click()
    page.wait_for_timeout(2500)
    f = fr()
    check("side panel shows expand toggle", f.inner_text("#btnExpand").strip() == "⤢")
    # Opened directly (no history to go back to): exit opens the last project.
    page.evaluate("location.hash = '#/plugins/project-markdown-note/index'")
    page.wait_for_timeout(2500)
    fl = page.frame_locator(".route-wrapper iframe")
    fl.locator("#viewNote:not([hidden])").wait_for(timeout=10000)
    check("direct full page shows exit toggle", fl.locator("#btnExpand").inner_text().strip() == "⤡")
    page.mouse.move(600, 500)  # dismiss the host tooltip left by the side-panel button
    page.wait_for_timeout(800)
    page.screenshot(path=str(OUT / "L8-direct-full.png"))
    try:
        fl.locator("#btnExpand").click(timeout=5000)
    except Exception as e:
        print("CLICKERR", str(e)[-600:])
        raise
    page.wait_for_timeout(2500)
    check("exit from direct full page lands on a work view", page.evaluate("location.hash").startswith(("#/project/", "#/tag/")))
    # Today view -> daily note.
    page.evaluate("location.hash = '#/tag/TODAY/tasks'")
    page.wait_for_timeout(2000)
    if not [fr_ for fr_ in page.frames if fr_.url.startswith("blob:")]:
        page.locator("button.plugin-side-panel-btn").first.click()
        page.wait_for_timeout(2500)
    f = fr()
    f.wait_for_function("document.querySelector('#viewMessage').innerText.includes('No daily note')", timeout=10000)
    today = time.strftime("%Y-%m-%d")
    f.click("#viewMessage button:has-text(\"Create today's note\")")
    f.wait_for_selector("#viewNote:not([hidden])", timeout=10000)
    check("Today: daily note created in Daily/", (vault / "Daily" / f"{today}.md").exists())
    page.screenshot(path=str(OUT / "L9-daily.png"))

    # Remove the plugin, install again: links come back from the local backup.
    page.wait_for_timeout(1500)
    check("backup file written", (fake_home / ".sp-project-markdown-note.json").exists())
    page.goto(APP + "#/config", wait_until="domcontentloaded")
    page.wait_for_timeout(2500)
    page.get_by_role("tab", name="Plugins").click()
    page.wait_for_timeout(1000)
    page.on("dialog", lambda d: d.accept())  # Remove asks with a native confirm()
    page.locator("mat-card", has_text="project-markdown-note").locator("button", has_text="Remove").first.click()
    page.wait_for_timeout(1000)
    if page.locator("mat-dialog-container button").count():
        print("REMOVE DIALOG:", page.locator("mat-dialog-container button").all_inner_texts())
        page.locator("mat-dialog-container button").last.click()
        page.wait_for_timeout(1500)
    check("plugin removed (its data deleted by the host)", page.locator("mat-card", has_text="project-markdown-note").count() == 0)
    page.set_input_files("input[type=file]", str(variant))
    page.wait_for_timeout(2500)
    sw = page.locator("mat-card", has_text="project-markdown-note").locator("button[role=switch]")
    if sw.get_attribute("aria-checked") != "true":
        sw.click()
        page.wait_for_timeout(1500)
    page.goto(APP + "#/project/INBOX_PROJECT/tasks", wait_until="domcontentloaded")
    page.wait_for_timeout(2000)
    page.mouse.move(600, 500)
    page.locator("button.plugin-side-panel-btn").first.click()
    page.wait_for_timeout(3000)
    f = fr()
    f.wait_for_selector("#viewNote:not([hidden])", timeout=15000)
    check("after Remove + reinstall: link restored from backup", "Typed in SP" in f.evaluate("document.querySelector('#editor').value"))
    page.screenshot(path=str(OUT / "L10-restored.png"))

    # The host logs a harmless "Duplicate side panel button" error when a plugin is
    # removed and re-installed in the same session; that is not the plugin's error.
    errors = [e for e in errors if "Duplicate side panel button" not in e]
    check("no page errors", not errors)
    if errors:
        print(errors[:5])
    b.close()

failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
