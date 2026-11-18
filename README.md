# Hungarian Pension Simulator – web version

Everything it calculates (the seven models, the
cohort-component population projection, scenarios, age trees and the CSV / XLSX / PDF / Markdown exports)
runs in the visitor's browser in JavaScript. A small PHP file, `api.php`, downloads the official KSH and
Eurostat tables, which browsers cannot fetch directly, and keeps one copy on the server for every visitor.


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
