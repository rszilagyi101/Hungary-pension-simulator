"""Build a single-file preview of the site (no PHP, bundled data, downloads switched off).

usage: python tools/build_preview.py [output.html]
Chart.js and the export libraries come from jsDelivr; everything else is inlined.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if not (ROOT / "index.html").exists():  # packaged layout: development/tools next to site/
    ROOT = ROOT.parent / "site"
out = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "preview.html")
html = (ROOT / "index.html").read_text(encoding="utf-8")

CDN = "https://cdn.jsdelivr.net/npm/"
VENDOR = {
    "jszip": CDN + "jszip@3.10.1/dist/jszip.min.js",
    "exceljs": CDN + "exceljs@4.4.0/dist/exceljs.min.js",
    "jspdf": CDN + "jspdf@2.5.1/dist/jspdf.umd.min.js",
    "autotable": CDN + "jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js",
}
cfg = ('<script>window.PS_CONFIG = { apiUrl: null, staticData: null, preview: true, vendorUrls: %s };</script>'
       % str(VENDOR).replace("'", '"'))
html = re.sub(r"<!--PS_CONFIG-->.*?<!--/PS_CONFIG-->", lambda m: cfg, html, flags=re.S)

css = (ROOT / "assets/css/style.css").read_text(encoding="utf-8")
css = re.sub(r"@font-face\s*\{.*?\}\s*", "", css, flags=re.S)
fonts = ('<link rel="preconnect" href="https://fonts.googleapis.com">'
         '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
         '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&display=swap">')
html = html.replace('<link rel="stylesheet" href="assets/css/style.css">', fonts + "<style>\n" + css + "\n</style>")
html = html.replace('<link rel="icon" href="assets/icon.svg" type="image/svg+xml">', "")


def inline(path):
    code = (ROOT / path).read_text(encoding="utf-8").replace("</script", "<\\/script")
    return f"<script>\n{code}\n</script>"


scripts = [f'<script src="{CDN}chart.js@4.4.1/dist/chart.umd.js"></script>']
for name in ["ps-defaults", "ps-core", "ps-data", "ps-population", "ps-models", "ps-scenarios", "ps-export", "ps-api", "app"]:
    scripts.append(inline(f"assets/js/{name}.js"))
scripts.insert(1, inline("assets/vendor/pdf-font-archivo.js"))  # PDF font (not on a CDN)
html = re.sub(r"<!--PS_SCRIPTS-->.*?<!--/PS_SCRIPTS-->", lambda m: "\n".join(scripts), html, flags=re.S)
assert "assets/" not in re.sub(r"<p.*?</p>", "", html.split("<body>")[0]), "local asset left in <head>"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(html, encoding="utf-8")
print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KB)")
