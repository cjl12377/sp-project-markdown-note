#!/usr/bin/env python3
"""Build a Super Productivity iframe plugin into a flat, installable zip.

Usage:
  python3 build_plugin.py <plugin_dir> [--esbuild PATH] [--out DIR] [--limit-kb 100]

<plugin_dir> must contain src/ with:
  manifest.json            (required)
  index.html               (required for iFrame plugins; must contain exactly one
                            <script src="app.js"></script> placeholder)
  app.js                   (iframe entry; ES modules allowed, bundled by esbuild)
  plugin.js                (optional host-side code; bundled by esbuild if it has
                            imports, else copied; a stub is written if missing)
  icon.svg                 (optional; use fill="currentColor")

What it does:
  1. Bundles src/app.js (and its npm imports) with esbuild into one IIFE.
  2. Wraps it so it starts after DOMContentLoaded. Hosts up to 19.3.x inject
     window.PluginAPI just before </body>, i.e. after an inline script earlier in
     the page; newer hosts inject it before the first <script>. Both work.
  3. Compacts the hand-written HTML/CSS and inlines the bundle.
  4. Fails if index.html exceeds the host limit (100 KB on released versions).
  5. Writes dist/ and <id>-<version>.zip with files at the zip root.
"""
import argparse
import json
import pathlib
import re
import shutil
import subprocess
import sys
import zipfile

ap = argparse.ArgumentParser()
ap.add_argument("plugin_dir")
ap.add_argument("--esbuild", default=None, help="path to esbuild binary (default: <plugin_dir>/node_modules/.bin/esbuild)")
ap.add_argument("--out", default=None, help="directory for the zip (default: plugin_dir)")
ap.add_argument("--limit-kb", type=float, default=100.0, help="index.html size limit in KB (released hosts: 100)")
a = ap.parse_args()

root = pathlib.Path(a.plugin_dir).resolve()
src = root / "src"
dist = root / "dist"
out_dir = pathlib.Path(a.out).resolve() if a.out else root
esbuild = pathlib.Path(a.esbuild) if a.esbuild else root / "node_modules" / ".bin" / "esbuild"

manifest = json.loads((src / "manifest.json").read_text())
for field in ("id", "name", "version", "manifestVersion", "hooks", "permissions"):
    if field not in manifest:
        sys.exit(f"manifest.json is missing '{field}' (hooks and permissions are required arrays; use [])")
if not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", manifest["id"]):
    sys.exit("manifest id must be a single safe token (kebab-case recommended)")

if dist.exists():
    shutil.rmtree(dist)
dist.mkdir()

files = ["manifest.json"]
shutil.copy(src / "manifest.json", dist / "manifest.json")

if manifest.get("iFrame"):
    html = (src / "index.html").read_text()
    marker = '<script src="app.js"></script>'
    if html.count(marker) != 1:
        sys.exit(f"src/index.html must contain exactly one {marker}")
    if not esbuild.exists():
        sys.exit(f"esbuild not found at {esbuild} (npm install --ignore-scripts esbuild)")
    bundle = dist / "_app.bundle.js"
    subprocess.run(
        [str(esbuild), str(src / "app.js"), "--bundle", f"--outfile={bundle}", "--platform=browser",
         "--target=es2020", "--format=iife", "--minify", "--legal-comments=none", "--log-level=warning"],
        check=True,
    )
    app_js = bundle.read_text().replace("</script>", "<\\/script>")
    bundle.unlink()
    wrapped = (
        "(function(){var go=function(){" + app_js + "};"
        "if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',go);}else{go();}})();"
    )
    html = re.sub(
        r"<style>(.*?)</style>",
        lambda m: "<style>" + re.sub(r"\s*([{};:,>])\s*", r"\1", re.sub(r"\s+", " ", m.group(1))).strip() + "</style>",
        html,
        flags=re.S,
    )
    html = re.sub(r"\s+", " ", html).replace("> <", "><")
    html = html.replace(marker, "<script>" + wrapped + "</script>")
    (dist / "index.html").write_text(html)
    files.append("index.html")
    size = len(html.encode("utf-8"))
    print(f"index.html: {size} bytes ({size / 1024:.1f} KB of {a.limit_kb:g} KB)", file=sys.stderr)
    if size > a.limit_kb * 1024:
        sys.exit("index.html exceeds the host limit: drop heavy dependencies (e.g. DOMPurify ~31 KB) or trim code")

if (src / "plugin.js").exists():
    code = (src / "plugin.js").read_text()
    if re.search(r"^\s*import\s", code, re.M):
        # plugin.js has no size cap that matters (5 MB), so heavy libraries can live
        # here and be shared with the iframes through the app window (same origin).
        if not esbuild.exists():
            sys.exit(f"esbuild not found at {esbuild}")
        subprocess.run(
            [str(esbuild), str(src / "plugin.js"), "--bundle", f"--outfile={dist / 'plugin.js'}",
             "--platform=browser", "--target=es2020", "--format=iife", "--minify",
             "--legal-comments=none", "--log-level=warning"],
            check=True,
        )
        print(f"plugin.js: {(dist / 'plugin.js').stat().st_size / 1024:.1f} KB (bundled)", file=sys.stderr)
    else:
        shutil.copy(src / "plugin.js", dist / "plugin.js")
else:
    (dist / "plugin.js").write_text("// UI lives in index.html.\n")
files.append("plugin.js")

icon = manifest.get("icon")
if icon:
    if not (src / icon).exists():
        sys.exit(f"manifest icon '{icon}' not found in src/")
    shutil.copy(src / icon, dist / icon)
    files.append(icon)

out_dir.mkdir(parents=True, exist_ok=True)
zip_path = out_dir / f"{manifest['id']}-{manifest['version']}.zip"
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
    for name in files:
        z.write(dist / name, name)
print(zip_path)
