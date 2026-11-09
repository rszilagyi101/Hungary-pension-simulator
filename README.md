# Hungarian Pension Simulator – web version

The same simulator as the desktop app, as a web page. Everything it calculates (the seven models, the
cohort-component population projection, scenarios, age trees and the CSV / XLSX / PDF / Markdown exports)
runs in the visitor's browser in JavaScript. A small PHP file, `api.php`, downloads the official KSH and
Eurostat tables, which browsers cannot fetch directly, and keeps one copy on the server for every visitor.

```
site/          ← upload the contents of this folder to your web space
  index.html     the page
  api.php        data service (download + cache of KSH/Eurostat tables)
  config.php     settings for the data service
  lib/           PHP code (not reachable from the web)
  cache/         where downloaded data is stored (must be writable)
  assets/        scripts, styles, fonts, export libraries
development/   tests against the Python app, mock KSH/Eurostat server, tools (do not upload)
.github/       GitHub workflow for hosting on GitHub Pages instead (see GITHUB.md)
```

**No PHP host?** Publish it free on GitHub Pages with a weekly automatic data update: see `GITHUB.md`.

## Put it online

1. You need ordinary web hosting with **PHP 7.4 or newer** (8.x recommended) and either the **curl**
   extension or `allow_url_fopen` switched on. Almost every shared host has both.
2. Upload everything inside `site/` (including the hidden `.htaccess` files) to your web space by FTP/SFTP
   or the host's file manager, for example to `public_html/pension/`.
3. Make the `cache/` folder writable by PHP (permissions 755, or 775 if your host asks for it).
4. Open the page, go to **Data** and press **Download latest official data**. The server fetches the KSH
   STADAT tables and the Eurostat population by age and sex with the EUROPOP projection (about 10–40 s).
   From then on every visitor gets that copy. Each projection variant is downloaded the first time it
   is chosen.

Check the server with `https://your-site/pension/api.php?action=ping`: it reports the PHP version, whether
the server can download (`can_download`) and whether `cache/` is writable.

Without PHP the page still works (opened from disk or on any static host): it then reads
`data/official.json` if present (written by `php lib/build_static.php`, which the GitHub workflow runs),
otherwise the bundled KSH tables. The download button is switched off in both cases.

### Options in `config.php`

| Setting | Meaning |
|---|---|
| `min_refresh_minutes` | A new download is made at most this often (default 30); in between, the stored copy is returned. |
| `refresh_key` | Leave empty to let any visitor press the download button. Set a word to require it; the page then asks for the key. |
| `http_timeout` | Seconds to wait for KSH and Eurostat. |
| `projection_codes` | Eurostat projection datasets tried in order (EUROPOP2025 `proj_25np`, then EUROPOP2023 `proj_23np`). |

### nginx

`.htaccess` files only work on Apache/LiteSpeed. On nginx add:

```
location ~ ^/(pension/)?(lib|cache|tests|tools)/ { deny all; }
location ~ /config(\.local)?\.php$ { deny all; }
```

## What stays where

* **Server:** only the official tables in `cache/official.json`. The server never runs the models and never
  receives visitor data.
* **Visitor's browser:** settings, data the visitor uploads or edits, and saved scenarios are kept in the
  browser's local storage. Clearing site data removes them. Other visitors never see them.

## Accuracy compared with the desktop (Python) app

The JavaScript engine was checked against the Python app on the same inputs:

* data table and provenance: identical; population projection: identical to 1e-11;
* ensemble forecast: within 0.25 % in 2030–2070 across six setting combinations; Holt, ratio model and ridge
  regression identical; random forest and gradient boosting within 0.6 % (different random numbers);
* recipients by sex and all 17 scenario parameters: same results and same expected/measured directions;
* after a server download: same dataset as the Python download, milestones within 0.13 %.

One deliberate difference: ARIMA uses the exact Gaussian likelihood. statsmodels approximates the initial
state with a large variance, so with the log option **off** ARIMA can land on a slightly different optimum
(differences of a few percent in that one model; the ensemble moves far less). With logs on (the default)
the two agree within 0.13 %.

## Development

```
cd development
node tests/check_pop.js                 # population engine vs reference.json
node tests/check_models.js default      # models (cases: default oldage reform fallback long tsvariants)
node tests/check_scenarios.js
php -S 127.0.0.1:8099 tests/mock_router.php     # mock KSH + Eurostat
cp tests/config.local.php.test ../site/config.local.php   # point api.php at the mock (remove afterwards!)
php -S 127.0.0.1:8098 -t ../site
python tools/build_preview.py preview.html      # single-file preview (no PHP, downloads off)
```

`tools/make_reference.py` and `tools/gen_defaults.py` regenerate the reference results and bundled default
tables from the Python project (`python tools/gen_defaults.py path/to/pension_sim`).

Third-party libraries (Chart.js, ExcelJS, jsPDF, jsPDF-AutoTable, JSZip) and the Archivo font are listed with
their licences in `site/assets/vendor/LICENSES.md` and `site/assets/fonts/Archivo-OFL.txt`.
Data: KSH STADAT and Eurostat. Results are simulations, not official forecasts.
