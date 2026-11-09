# Publishing the Pension Simulator on GitHub Pages

GitHub Pages hosts static files for free but cannot run PHP. Instead of `api.php`, a GitHub Actions
workflow (`.github/workflows/update-data.yml`) runs the same PHP download code on GitHub's machines:

* every Monday at 04:17 UTC (and whenever you start it by hand) it downloads the KSH and Eurostat tables,
* saves them in the repository as `site/data/official.json` (only when something changed),
* publishes the `site` folder without the PHP files to `https://<your-user>.github.io/<repository>/`.

The page reads `data/official.json` automatically. Visitors cannot start a download themselves
(the button is off); everything else works exactly as on a PHP host.

## 1. Create the repository

1. Sign in at <https://github.com> (create a free account if needed).
2. Top right **+** → **New repository**.
3. Name: for example `pension-simulator`. Choose **Public** (Pages on a private repository needs a paid plan).
4. Leave "Add a README" unticked and press **Create repository**.

## 2. Upload the files

The repository must look like this (the contents of the unzipped `pension-simulator-web` folder):

```
.github/workflows/update-data.yml
development/
site/
README.md
GITHUB.md
.gitignore
```

**In the browser**

1. On the new, empty repository page click **uploading an existing file**.
2. Drag in the folders `site` and `development` and the files `README.md`, `GITHUB.md`.
   (Drag the folders themselves, not the zip.) Press **Commit changes**.
3. The `.github` folder is hidden on Mac and is often skipped by drag and drop, so create the workflow by hand:
   **Add file → Create new file**, type the name `.github/workflows/update-data.yml` (the slashes create the
   folders), paste the contents of that file from the zip, and press **Commit changes**.

**Or with git on the command line** (inside the unzipped `pension-simulator-web` folder):

```
git init -b main
git add .
git commit -m "Pension simulator"
git remote add origin https://github.com/<your-user>/pension-simulator.git
git push -u origin main
```

## 3. Switch on Pages and allow the workflow to save data

1. Repository **Settings → Pages**. Under **Build and deployment → Source** choose **GitHub Actions**.
2. **Settings → Actions → General → Workflow permissions**: choose **Read and write permissions**, **Save**.
   (Needed so the workflow can save `official.json` into the repository.)

## 4. Run it the first time

1. Open the **Actions** tab. If GitHub asks, press **I understand my workflows, go ahead and enable them**.
2. Select **Update data and publish site** on the left, then **Run workflow** → branch `main` → **Run workflow**.
   (A run started by your upload may already show a red cross, because Pages was not yet switched on.
   That is expected; the new run fixes it.)
3. After 1–3 minutes both jobs (*build* and *deploy*) show a green tick. The address of the site is shown
   under the *deploy* job and in **Settings → Pages**:
   `https://<your-user>.github.io/pension-simulator/`

## 5. Check the data

Open the site → **Data** tab. The grey box says *"Using KSH and Eurostat data downloaded automatically on …"*
and the list below it shows every source with **Loaded** or **Not loaded**.

To see details, open the workflow run → *build* → step **Download KSH and Eurostat data**. Each source is
listed with `ok` or `FAIL`. If a source fails (for example a KSH table moved or a site was down), the previous
values are kept and the site is still published. If KSH or Eurostat refused GitHub's servers completely, the
page falls back to the bundled KSH tables (1990–2026), which still gives full results.

## 6. Later

* **Data updates:** automatic every Monday. Start one any time with **Actions → Update data and publish site →
  Run workflow**. To change the day or time, edit the `cron` line in the workflow (times are UTC; Budapest is
  UTC+1 in winter, UTC+2 in summer). Examples: `"17 4 1 * *"` = 1st of each month, `"17 4 * * *"` = daily.
* **Changing the page:** edit or upload files under `site/`; every push to `main` republishes the site in a
  minute or two (without downloading data again).
* **Pause:** **Actions → Update data and publish site → ⋯ → Disable workflow**. The published site stays online.
* **GitHub's 60-day rule:** in public repositories GitHub switches off scheduled workflows after 60 days
  without any activity in the repository. If that happens you get an e-mail; press **Enable workflow** on the
  Actions tab. Data updates that change something count as activity.
* **Own domain (optional):** **Settings → Pages → Custom domain**, then follow GitHub's DNS instructions.

## Test the GitHub mode on your computer

```
php site/lib/build_static.php            # writes site/data/official.json (needs internet)
python3 -m http.server 8000 -d site      # a static server, like GitHub Pages
```

Open <http://localhost:8000>. Without PHP serving the page, it reads `data/official.json`, exactly as on
GitHub Pages. (`php -S localhost:8000 -t site` would instead use `api.php`, like a PHP host.)

## What is public

Everything in a public repository can be read by anyone: the code and the downloaded official statistics.
Nothing else is stored there. Visitors' settings, uploaded data and saved scenarios stay in their own
browsers and never reach GitHub.
