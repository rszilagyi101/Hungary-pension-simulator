/* Pension Simulator – in-browser stand-in for the desktop app's server routes.
   PS.api.call(url, opts) answers like the Flask JSON routes; PS.api.file(url, opts) builds an export
   and returns {blob, name}. Official data comes from api.php when the site has it (PHP mode);
   without it the bundled default tables are used (static mode). */
(function (G) {
  "use strict";
  const PS = G.PS, U = PS.util, SET = PS.settings, DATA = PS.data, X = PS.export, SC = PS.scenarios;
  const CFG = (PS.config = Object.assign({ apiUrl: "api.php", staticData: "data/official.json", preview: false, vendorBase: "assets/vendor/" }, G.PS_CONFIG || {}));
  const API = (PS.api = { mode: "static", server: null });

  const RUNS = new Map(), SCEN_RUNS = new Map();
  const keep = (map, id, v, max) => { map.set(id, v); while (map.size > max) map.delete(map.keys().next().value); };
  const newId = () => Math.random().toString(16).slice(2, 14);
  const fail = (msg, extra = {}) => { const e = new Error(msg); Object.assign(e, extra); throw e; };

  // JSON-safe copy for the page: NaN → null, Map → object, typed arrays → arrays; big internal tables dropped
  const clean = (v) => JSON.parse(JSON.stringify(v, function (k, x) {
    if (k === "ages_total" || k === "ages_sex" || k === "full") return undefined;
    if (typeof x === "number" && !Number.isFinite(x)) return null;
    if (x instanceof Map) return Object.fromEntries(x);
    if (ArrayBuffer.isView(x)) return Array.from(x);
    return x;
  }));

  const datasets = new Map();
  const dataset = (variant = "BSL") => { if (!datasets.has(variant)) datasets.set(variant, DATA.buildDataset(variant)); return datasets.get(variant); };
  const dataChanged = () => { datasets.clear(); PS.population.resetCache && PS.population.resetCache(); };
  const payload = (variant) => clean(DATA.payload(dataset(variant)));

  // ------------------------------------------------------------------ server data (PHP mode)
  API.boot = async () => {
    if (!CFG.apiUrl) { await bootStaticFile(); return API.status(); }
    try {
      const r = await fetch(`${CFG.apiUrl}?action=data`, { headers: { Accept: "application/json" }, cache: "no-cache" });
      const ct = r.headers.get("content-type") || "";
      if (!r.ok || !ct.includes("json")) throw new Error(`api.php answered ${r.status}`);
      const body = await r.json();
      API.mode = "php";
      API.server = { available: !!body.available };
      if (body.available) { DATA.setOfficial(body); dataChanged(); }
      fetch(`${CFG.apiUrl}?action=ping`).then((p) => p.json()).then((p) => { API.server = { ...API.server, ...p }; G.dispatchEvent(new Event("ps-server")); }).catch(() => {});
    } catch (e) {
      API.mode = "static"; // plain HTML hosting (GitHub Pages), or opened from disk
      await bootStaticFile();
    }
    return API.status();
  };
  // without PHP: data/official.json written by lib/build_static.php (for example by the GitHub workflow)
  const bootStaticFile = async () => {
    if (!CFG.staticData) return;
    try {
      const r = await fetch(CFG.staticData, { cache: "no-cache" });
      if (!r.ok) return;
      const body = await r.json();
      if (body && body.available && body.data) { DATA.setOfficial(body); dataChanged(); API.mode = "file"; }
    } catch (e) { /* no file: bundled tables */ }
  };
  API.status = () => ({ mode: API.mode, preview: !!CFG.preview, server: API.server, meta: DATA.meta, hasOfficial: !!DATA.official });

  const refresh = async (variant, key) => {
    if (CFG.preview) fail("This preview has no data service. On your own PHP site this button downloads the latest KSH and Eurostat tables.");
    if (API.mode !== "php") fail(API.mode === "file" ? "On this site the data is updated automatically (see the date above)." : "Downloading needs api.php on a PHP server. The page is using the bundled default tables.");
    const r = await fetch(`${CFG.apiUrl}?action=refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ variant, key: key || undefined }) });
    let body; try { body = await r.json(); } catch (e) { fail(`The data service failed (${r.status}).`); }
    if (!r.ok) fail(body.error || `The data service failed (${r.status}).`, { needsKey: !!body.needs_key });
    if (body.available) { DATA.setOfficial(body); dataChanged(); }
    const rep = body.report || {};
    return { report: rep, data: payload(variant) };
  };

  // ------------------------------------------------------------------ reading files
  const readXlsx = async (file, sheetName) => {
    const ExcelJS = await X.loadLib("exceljs"), wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await file.arrayBuffer());
    const ws = (sheetName && wb.getWorksheet(sheetName)) || wb.worksheets[0];
    if (!ws) fail("The workbook has no sheets.");
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = [];
      for (let c = 1; c <= row.cellCount; c++) {
        let v = row.getCell(c).value;
        if (v && typeof v === "object") v = v.result !== undefined ? v.result : v.text !== undefined ? v.text : v.richText ? v.richText.map((t) => t.text).join("") : String(v);
        vals.push(v === undefined ? null : v);
      }
      rows.push(vals);
    });
    if (!rows.length) fail("The sheet is empty.");
    return rows;
  };
  const records = (rows) => rows.slice(1).map((r) => Object.fromEntries(rows[0].map((h, i) => [String(h ?? "").trim(), r[i]])));
  const isXlsx = (name) => /\.xlsx?$/i.test(name);

  const uploadData = async (fd) => {
    const f = fd.get("file"), mode = fd.get("mode") || "override", variant = fd.get("variant") || "BSL";
    if (!f || !f.name) fail("Choose a CSV or XLSX file with a 'year' column.");
    if (f.size > 10 * 1024 * 1024) fail("The file is larger than 10 MB.");
    let parsed;
    if (isXlsx(f.name)) { const rows = await readXlsx(f); parsed = DATA.tableToRows(rows[0], rows.slice(1)); }
    else parsed = DATA.parseCsvText(await f.text());
    if (!parsed.rows.length) fail("No rows with a valid year were found.");
    DATA.mergeUser(parsed.rows, mode);
    dataChanged();
    return { message: `Added ${parsed.rows.length} rows (${parsed.columns.join(", ")}). They are kept in this browser only.`, data: payload(variant) };
  };

  const importSettings = async (fd) => {
    const f = fd.get("file");
    if (!f || !f.name) fail("Choose a settings file (.json, .csv or .xlsx).");
    try {
      if (/\.json$/i.test(f.name)) return { settings: SET.fromJsonText(await f.text()) };
      if (isXlsx(f.name)) return { settings: SET.fromTable(records(await readXlsx(f, "Settings"))) };
      const rows = PS.csv.parse((await f.text()).replace(/^﻿/, ""), ",");
      return { settings: SET.fromTable(records(rows)) };
    } catch (e) { fail(`Could not read settings: ${e.message}`); }
  };

  // ------------------------------------------------------------------ JSON routes
  const body = (opts) => { try { return opts && typeof opts.body === "string" ? JSON.parse(opts.body) : {}; } catch (e) { return {}; } };
  API.call = async (url, opts = {}) => {
    const u = new URL(url, "http://x"), path = u.pathname, b = body(opts);
    switch (path) {
      case "/api/settings/spec": return { spec: SET.SPEC, defaults: SET.defaults() };
      case "/api/settings/import": return importSettings(opts.body);
      case "/api/data": return payload(u.searchParams.get("variant") || "BSL");
      case "/api/data/refresh": return refresh(b.variant || "BSL", b.key);
      case "/api/data/upload": return uploadData(opts.body);
      case "/api/data/edit": {
        const rows = new Map();
        for (const e of b.edits || []) {
          if (!DATA.COLUMNS.includes(e.column)) continue;
          const y = Number(e.year), r = rows.get(y) || { year: y };
          const v = e.value === "" || e.value === null || e.value === undefined ? null : Number(e.value);
          r[e.column] = v; if (v === null) r.__clear = true;
          rows.set(y, r);
        }
        if (rows.size) { DATA.mergeUser([...rows.values()], "override"); dataChanged(); }
        return { message: `Saved ${(b.edits || []).length} edits in this browser.`, data: payload(b.variant || "BSL") };
      }
      case "/api/data/reset": DATA.resetUser(); dataChanged(); return { message: "Your added data was removed from this browser.", data: payload(b.variant || "BSL") };
      case "/api/run": {
        const s = SET.validate(b);
        const ds = dataset(s.projection_variant);
        const res = PS.models.run(ds, s);
        const id = newId();
        keep(RUNS, id, { s, res, ds }, 6);
        return { run_id: id, settings: s, result: clean(res) };
      }
      case "/api/scenarios/params": return { params: SC.PARAMS, categories: SC.CATEGORY_LABELS, saved: SC.loadSaved() };
      case "/api/scenarios/save": {
        const name = String(b.name || "").trim();
        if (!name) fail("Give the scenario a name before saving.");
        return { saved: SC.save(name, b.selection || {}), message: `Saved “${name}” in this browser.` };
      }
      case "/api/scenarios/delete": return { saved: SC.remove(b.name || ""), message: `Deleted “${b.name}”.` };
      case "/api/scenarios/run": {
        const base = SET.validate(b.settings || {});
        const sel = Object.fromEntries(Object.entries(b.selection || {}).filter(([k]) => SC.BY_KEY[k]));
        const sr = await SC.run(dataset(base.projection_variant), base, sel, { name: b.name || "Custom scenario", presets: b.presets !== false, impacts: b.impacts !== false, impactMode: b.impact_mode || "within", onProgress: opts.onProgress });
        const id = newId();
        keep(SCEN_RUNS, id, sr, 4);
        return { run_id: id, result: clean(sr) };
      }
    }
    fail(`Unknown request ${path}`);
  };

  // ------------------------------------------------------------------ file routes
  const T = { csv: "text/csv;charset=utf-8", md: "text/markdown;charset=utf-8", json: "application/json" };
  const text = (t, type) => new Blob([t], { type });
  API.file = async (url, opts = {}) => {
    const u = new URL(url, "http://x"), parts = u.pathname.split("/").filter(Boolean), b = body(opts), st = U.stamp();
    if (u.pathname === "/api/data/template") return { blob: text(DATA.templateCsv(), T.csv), name: "pension_data_template.csv" };
    if (u.pathname === "/api/data/download") return { blob: text(X.csv(X.dataFrame(dataset(u.searchParams.get("variant") || "BSL"))), T.csv), name: `pension_input_data_${st}.csv` };
    if (parts[1] === "settings" && parts[2] === "export") {
      const s = SET.validate(b);
      if (parts[3] === "json") return { blob: text(JSON.stringify({ settings: s }, null, 2), T.json), name: `pension_settings_${st}.json` };
      return { blob: text(X.csv(X.settingsFrame(s)), T.csv), name: `pension_settings_${st}.csv` };
    }
    if (parts[1] === "export") {
      const r = RUNS.get(parts[2]);
      if (!r) fail("This run expired. Run the simulation again, then export.");
      const { s, res, ds } = r, name = `pension_simulation_${st}`;
      switch (parts[3]) {
        case "csv": return { blob: text(X.csv(X.resultsFrame(res)), T.csv), name: `${name}.csv` };
        case "popcsv": return { blob: text(X.csv(X.populationFrame(res)), T.csv), name: `population_${st}.csv` };
        case "agecsv": return { blob: text(X.csv(X.ageStructureFrame(res)), T.csv), name: `population_by_age_sex_${st}.csv` };
        case "sexcsv": return { blob: text(X.csv(X.sexFrame(res)), T.csv), name: `pensioners_by_sex_${st}.csv` };
        case "csvzip": return { blob: await X.csvBundle(res, s, ds), name: `${name}_csv.zip` };
        case "xlsx": return { blob: await X.xlsx(res, s, ds), name: `${name}.xlsx` };
        case "pdf": return { blob: await X.pdf(res, s), name: `${name}.pdf` };
        case "md": return { blob: text(X.md(res, s), T.md), name: `${name}.md` };
      }
    }
    if (parts[1] === "scenarios" && parts[2] === "export") {
      const sr = SCEN_RUNS.get(parts[3]);
      if (!sr) fail("This scenario run expired. Run it again, then export.");
      const name = `scenario_${st}`;
      switch (parts[4]) {
        case "csv": return { blob: text(X.csv(X.scenarioSeriesFrame(sr)), T.csv), name: `${name}.csv` };
        case "xlsx": return { blob: await X.scenarioXlsx(sr), name: `${name}.xlsx` };
        case "md": return { blob: text(X.scenarioMd(sr), T.md), name: `${name}.md` };
        case "pdf": return { blob: await X.scenarioPdf(sr), name: `${name}.pdf` };
        case "json": return { blob: text(JSON.stringify({ name: sr.name, selection: sr.selection }, null, 2), T.json), name: `${name}_definition.json` };
      }
    }
    fail(`Unknown export ${u.pathname}`);
  };
})(globalThis);
