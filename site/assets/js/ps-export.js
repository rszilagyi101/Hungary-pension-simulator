/* Pension Simulator – exports built in the browser (port of core/exporters.py).
   CSV and Markdown need nothing extra; zip, Excel and PDF load their libraries on first use. */
(function (G) {
  "use strict";
  const PS = G.PS, U = PS.util, SET = PS.settings, D = G.PS_DEFAULTS;
  const X = (PS.export = {});
  const fmt = (v, nd = 0) => (v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v))) ? "" : (typeof v === "number" ? U.fmt(v, nd) : String(v));
  const sgn = (v, nd) => (U.nan(v) ? "" : (v >= 0 ? "+" : "-") + U.fmt(Math.abs(v), nd));
  X.SOURCES = D.sources;

  // ------------------------------------------------------------------ libraries (loaded on demand)
  const LIBS = {
    jszip: { file: "jszip.min.js", global: "JSZip" },
    exceljs: { file: "exceljs.min.js", global: "ExcelJS" },
    jspdf: { file: "jspdf.umd.min.js", global: "jspdf" },
    autotable: { file: "jspdf.plugin.autotable.min.js", global: null, after: "jspdf" },
    pdffont: { file: "pdf-font-archivo.js", global: "PS_PDF_FONT" },
  };
  const loading = {};
  X.loadLib = (name) => {
    const lib = LIBS[name];
    if (lib.global && G[lib.global]) return Promise.resolve(G[lib.global]);
    if (loading[name]) return loading[name];
    const base = (PS.config && PS.config.vendorBase) || "assets/vendor/";
    loading[name] = (lib.after ? X.loadLib(lib.after) : Promise.resolve()).then(() => new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = ((PS.config && PS.config.vendorUrls) || {})[name] || base + lib.file;
      s.onload = () => res(lib.global ? G[lib.global] : true);
      s.onerror = () => { delete loading[name]; rej(new Error(`Could not load ${lib.file}. Check that the assets/vendor folder was uploaded.`)); };
      document.head.appendChild(s);
    }));
    return loading[name];
  };

  // ------------------------------------------------------------------ tables (same columns as the desktop app)
  const okModels = (res) => res.enabled.filter((k) => res.models[k].ok);
  X.resultsFrame = (res) => {
    const ok = okModels(res), exog = ["population", "pop_65plus", "share_65plus", "life_expectancy", "retirement_age", "pop_ret_age"];
    const rows = [];
    res.hist_years.forEach((y, i) => { const ex = res.hist_exog[i]; rows.push({ year: y, type: "observed", observed: res.hist_values[i], ensemble: null, lower: null, upper: null, ...Object.fromEntries(ok.map((k) => [k, null])), ...Object.fromEntries(exog.map((c) => [c, ex[c]])) }); });
    res.future_years.forEach((y, i) => { const ex = res.future_exog[i]; rows.push({ year: y, type: "forecast", observed: null, ensemble: res.ensemble.pred[i], lower: res.ensemble.lo[i], upper: res.ensemble.hi[i], ...Object.fromEntries(ok.map((k) => [k, res.models[k].pred[i]])), ...Object.fromEntries(exog.map((c) => [c, ex[c]])) }); });
    const cols = ["year", "type", "observed", "ensemble", "lower", "upper", ...ok, ...exog];
    const bs = res.by_sex || {};
    if (bs.available) {
      const hm = new Map(bs.hist_years.map((y, i) => [y, [bs.men[i], bs.women[i]]]));
      const fm = new Map(bs.future_years.map((y, i) => [y, i]));
      for (const r of rows) {
        const h = hm.get(r.year), f = fm.get(r.year);
        r.observed_men = h ? h[0] : null; r.observed_women = h ? h[1] : null;
        r.ensemble_men = f !== undefined ? bs.men_pred[f] : null; r.lower_men = f !== undefined ? bs.men_lo[f] : null; r.upper_men = f !== undefined ? bs.men_hi[f] : null;
        r.ensemble_women = f !== undefined ? bs.women_pred[f] : null; r.lower_women = f !== undefined ? bs.women_lo[f] : null; r.upper_women = f !== undefined ? bs.women_hi[f] : null;
        const m = r.observed_men ?? r.ensemble_men, w = r.observed_women ?? r.ensemble_women;
        r.share_women_pct = m !== null && w !== null ? (w / (m + w)) * 100 : null;
      }
      cols.push("observed_men", "observed_women", "ensemble_men", "lower_men", "upper_men", "ensemble_women", "lower_women", "upper_women", "share_women_pct");
    }
    for (const r of rows) {
      r.retirement_age_men = bs.ret_age_men ? bs.ret_age_men[r.year] ?? null : null;
      r.retirement_age_women = bs.ret_age_women ? bs.ret_age_women[r.year] ?? null : null;
      const v = r.observed ?? r.ensemble; r.per_1000_population = r.population ? (v / r.population) * 1000 : null;
    }
    cols.push("retirement_age_men", "retirement_age_women", "per_1000_population");
    const ren = Object.fromEntries(ok.map((k) => [k, `model_${k}`]));
    return { cols: cols.map((c) => ren[c] || c), rows: rows.map((r) => Object.fromEntries(cols.map((c) => [ren[c] || c, r[c]]))) };
  };
  X.metricsFrame = (res) => {
    const rows = res.enabled.map((k) => { const m = res.models[k]; return { model: SET.MODEL_LABELS[k], status: m.ok ? "ok" : m.error || "failed", weight: res.weights[k] || 0, mae: m.metrics ? m.metrics.mae : null, rmse: m.metrics ? m.metrics.rmse : null, mape_pct: m.metrics ? m.metrics.mape : null }; });
    const em = res.ensemble_metrics;
    rows.push({ model: "Ensemble", status: "ok", weight: 1, mae: em.mae, rmse: em.rmse, mape_pct: em.mape });
    return { cols: ["model", "status", "weight", "mae", "rmse", "mape_pct"], rows };
  };
  X.milestonesFrame = (res) => ({ cols: ["year", "ensemble", "men", "women", "lower", "upper", "change_vs_last_observed_pct", "per_1000_population", "retirement_age"],
    rows: res.milestones.map((m) => ({ year: m.year, ensemble: m.value, men: m.men, women: m.women, lower: m.lo, upper: m.hi, change_vs_last_observed_pct: m.change_pct, per_1000_population: m.per_1000, retirement_age: m.retirement_age })) });
  X.settingsFrame = (s) => ({ cols: ["key", "value", "label", "group"], rows: SET.toRows(s) });
  const POP_COLS = ["year", "type", "total", "total_low", "total_high", "male", "female", "share_women", "women_per_1000_men", "age_0_14_m", "age_0_14_f", "age_15_64_m", "age_15_64_f", "age_65_plus_m", "age_65_plus_f", "age_80_plus_m", "age_80_plus_f", "age_0_14", "age_15_64", "age_65_plus", "age_80_plus", "share_0_14", "share_15_64", "share_65_plus", "share_80_plus", "old_age_dependency", "median_age", "births", "deaths", "net_migration", "tfr", "e0_m", "e0_f", "age_source"];
  X.populationFrame = (res) => {
    const pop = res.population;
    return { cols: [...POP_COLS, "eurostat_projection"], rows: pop.rows.map((r) => ({ ...Object.fromEntries(POP_COLS.map((c) => [c, r[c] ?? null])), eurostat_projection: pop.eurostat_totals[r.year] ?? null })) };
  };
  X.ageStructureFrame = (res) => {
    const rows = [];
    Object.keys(res.population.pyramids).map(Number).sort((a, b) => a - b).forEach((y) => {
      const p = res.population.pyramids[y];
      for (const sex of ["M", "F"]) p[sex].forEach((v, a) => rows.push({ year: y, type: p.type, sex, age: a === 90 ? "90+" : a, population: v }));
    });
    return { cols: ["year", "type", "sex", "age", "population"], rows };
  };
  X.pyramidWide = (res, years) => {
    const pyr = res.population.pyramids, cols = ["age"], rows = U.range(0, 91).map((a) => ({ age: a === 90 ? "90+" : String(a) }));
    for (const y of years) { const p = pyr[y]; if (!p) continue; cols.push(`${y} men`, `${y} women`); rows.forEach((r, a) => { r[`${y} men`] = p.M[a]; r[`${y} women`] = p.F[a]; }); }
    return { cols, rows };
  };
  X.validationFrame = (res) => ({ cols: ["indicator", "projected", "observed", "error_pct"], rows: (res.population.validation && res.population.validation.rows) || [] });
  X.sexFrame = (res) => {
    const bs = res.by_sex || {};
    if (!bs.available) return { cols: [], rows: [] };
    const rows = bs.hist_years.map((y, i) => ({ year: y, type: "observed", men: bs.men[i], women: bs.women[i], share_women_pct: bs.share_women_hist[i], eligible_men: bs.eligible_men_hist[i], eligible_women: bs.eligible_women_hist[i], recipients_per_eligible_men: bs.ratio_men_hist[i], recipients_per_eligible_women: bs.ratio_women_hist[i] }));
    bs.future_years.forEach((y, i) => rows.push({ year: y, type: "forecast", men: bs.men_pred[i], women: bs.women_pred[i], men_lower: bs.men_lo[i], men_upper: bs.men_hi[i], women_lower: bs.women_lo[i], women_upper: bs.women_hi[i], share_women_pct: bs.share_women_fut[i], eligible_men: bs.eligible_men_fut[i], eligible_women: bs.eligible_women_fut[i], recipients_per_eligible_men: bs.ratio_men_fut[i], recipients_per_eligible_women: bs.ratio_women_fut[i], unreconciled_men: bs.raw_men[i], unreconciled_women: bs.raw_women[i] }));
    rows.forEach((r) => { r.retirement_age_men = bs.ret_age_men[r.year] ?? null; r.retirement_age_women = bs.ret_age_women[r.year] ?? null; });
    return { cols: ["year", "type", "men", "women", "share_women_pct", "eligible_men", "eligible_women", "recipients_per_eligible_men", "recipients_per_eligible_women", "men_lower", "men_upper", "women_lower", "women_upper", "unreconciled_men", "unreconciled_women", "retirement_age_men", "retirement_age_women"], rows };
  };
  X.dataFrame = (ds) => ({ cols: ["year", ...PS.data.COLUMNS], rows: PS.data.tableRows(ds) });
  X.provFrame = (ds) => ({ cols: ["year", ...PS.data.COLUMNS], rows: PS.data.provRows(ds) });
  X.csv = (frame, bom = true) => (bom ? "﻿" : "") + PS.csv.write(frame.rows, frame.cols);

  // ------------------------------------------------------------------ charts as images (Chart.js, off screen)
  const C = { ink: "#1f2e3b", observed: "#2c5e4c", forecast: "#b13a2f", men: "#3d6fa5", women: "#b0558a", grid: "#e6eaee", muted: "#5d6b79" };
  const MODEL_COLORS = { arima: "#3d6fa5", ets: "#8a5a9e", structural: "#c07f1d", rf: "#4f8f8a", gb: "#6b7f2b", ridge: "#7a6a58", mlp: "#b0558a" };
  let IMG_TYPE = "image/png";  // PDFs switch to JPEG, which jsPDF stores compressed
  const img = (config, w, h) => {
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h; cv.style.width = w + "px"; cv.style.height = h + "px";
    const base = { responsive: false, animation: false, devicePixelRatio: 2 };
    config.options = { ...base, ...(config.options || {}), plugins: { legend: { labels: { boxWidth: 12, font: { size: 10 } } }, ...((config.options || {}).plugins || {}) } };
    config.plugins = [...(config.plugins || []), { id: "white", beforeDraw: (c) => { const x = c.ctx; x.save(); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height); x.restore(); } }];
    const ch = new G.Chart(cv.getContext("2d"), config);
    const url = IMG_TYPE === "image/jpeg" ? cv.toDataURL("image/jpeg", 0.92) : cv.toDataURL("image/png");
    ch.destroy();
    return url;
  };
  const millions = (v) => `${(v / 1e6).toFixed(2)} M`;
  const lineOpts = (title, yfmt = millions) => ({ plugins: { title: { display: !!title, text: title, align: "start", color: C.ink, font: { size: 13 } }, legend: { position: "bottom" } }, scales: { y: { ticks: { callback: yfmt, font: { size: 10 } }, grid: { color: C.grid } }, x: { ticks: { maxRotation: 0, autoSkipPadding: 12, font: { size: 10 } }, grid: { display: false } } } });
  X.chartMain = (res, w = 900, h = 420) => {
    const years = [...res.hist_years, ...res.future_years], nH = res.hist_years.length, last = res.hist_values[nH - 1];
    const fut = (a) => { const o = [...Array(nH).fill(null), ...a]; o[nH - 1] = last; return o; };
    const ds = [{ label: "_lo", data: fut(res.ensemble.lo), borderWidth: 0, pointRadius: 0 }, { label: "Prediction interval", data: fut(res.ensemble.hi), borderWidth: 0, pointRadius: 0, fill: "-1", backgroundColor: "rgba(177,58,47,.13)" },
      { label: "Observed (KSH)", data: [...res.hist_values, ...res.future_years.map(() => null)], borderColor: C.observed, borderWidth: 2.4, pointRadius: 0 }];
    okModels(res).forEach((k) => ds.push({ label: SET.MODEL_LABELS[k], data: fut(res.models[k].pred), borderColor: MODEL_COLORS[k], borderWidth: 1.1, borderDash: [5, 4], pointRadius: 0 }));
    ds.push({ label: "Ensemble forecast", data: fut(res.ensemble.pred), borderColor: C.forecast, borderWidth: 2.6, pointRadius: 0 });
    const o = lineOpts(`${res.target_label} in Hungary, observed and simulated`);
    o.plugins.legend.labels = { filter: (i) => i.text !== "_lo", boxWidth: 12, font: { size: 9 } };
    return img({ type: "line", data: { labels: years, datasets: ds }, options: o }, w, h);
  };
  X.chartSex = (res, w = 900, h = 300) => {
    const bs = res.by_sex; if (!bs || !bs.available) return null;
    const years = [...bs.hist_years, ...bs.future_years], nH = bs.hist_years.length;
    const H = (a) => [...a, ...bs.future_years.map(() => null)], F = (a, l) => { const o = [...Array(nH).fill(null), ...a]; o[nH - 1] = l; return o; };
    const ds = [];
    for (const [k, lab, col] of [["men", "Men", C.men], ["women", "Women", C.women]]) {
      ds.push({ label: `${lab}, observed`, data: H(bs[k]), borderColor: col, borderWidth: 2.2, pointRadius: 0 });
      ds.push({ label: `${lab}, forecast`, data: F(bs[`${k}_pred`], bs[k][nH - 1]), borderColor: col, borderWidth: 2.2, borderDash: [6, 4], pointRadius: 0 });
    }
    return img({ type: "line", data: { labels: years, datasets: ds }, options: lineOpts(`${res.target_label} by sex`) }, w, h);
  };
  X.chartPopulation = (res, w = 900, h = 320) => {
    const rows = res.population.rows, years = rows.map((r) => r.year), base = res.population.base_year;
    const ds = [{ label: "_lo", data: rows.map((r) => r.total_low ?? (r.year === base ? r.total : null)), borderWidth: 0, pointRadius: 0 },
      { label: "Low–high variants", data: rows.map((r) => r.total_high ?? (r.year === base ? r.total : null)), borderWidth: 0, pointRadius: 0, fill: "-1", backgroundColor: "rgba(61,111,165,.15)" },
      { label: "Observed (KSH)", data: rows.map((r) => (r.type === "observed" ? r.total : null)), borderColor: C.observed, borderWidth: 2.2, pointRadius: 0 },
      { label: "Cohort-component projection", data: rows.map((r) => (r.type === "projection" || r.year === base ? r.total : null)), borderColor: C.men, borderWidth: 2.2, pointRadius: 0 }];
    const es = res.population.eurostat_totals;
    if (es && Object.keys(es).length) ds.push({ label: "Eurostat EUROPOP", data: years.map((y) => es[y] ?? null), borderColor: "#8a5a9e", borderDash: [6, 4], borderWidth: 1.4, pointRadius: 0 });
    const o = lineOpts("Population of Hungary on 1 January", (v) => `${(v / 1e6).toFixed(1)} M`);
    o.plugins.legend.labels = { filter: (i) => i.text !== "_lo", boxWidth: 12, font: { size: 9 } };
    return img({ type: "line", data: { labels: years, datasets: ds }, options: o }, w, h);
  };
  X.chartAgeGroups = (res, w = 900, h = 300) => {
    const rows = res.population.rows;
    const ds = [["0–14", "age_0_14", "#c9a24a"], ["15–64", "age_15_64", "#9fb4c7"], ["65+", "age_65_plus", "#b13a2f"]].map(([l, k, c]) => ({ label: l, data: rows.map((r) => r[k]), fill: true, backgroundColor: c, borderColor: c, pointRadius: 0, borderWidth: 1 }));
    const o = lineOpts("Age structure (main age groups)", (v) => `${(v / 1e6).toFixed(0)} M`);
    o.scales.y.stacked = true; o.scales.y.min = 0;
    return img({ type: "line", data: { labels: rows.map((r) => r.year), datasets: ds }, options: o }, w, h);
  };
  X.chartPyramid = (res, year, w = 300, h = 380, xmax = null) => {
    const p = res.population.pyramids[year]; if (!p) return null;
    const bs = res.by_sex || {}, ram = (bs.ret_age_men || {})[year] ?? 65, raf = (bs.ret_age_women || {})[year] ?? 65;
    const labels = U.range(0, 91).map((a) => (a === 90 ? "90+" : String(a))).reverse();
    const rev = (a) => [...a].reverse();
    const M = rev(p.M.map((v) => -v / 1000)), F = rev(p.F.map((v) => v / 1000));
    const cm = rev(U.range(0, 91).map((a) => (a >= ram ? "#1f4f82" : "#7fa3cb"))), cf = rev(U.range(0, 91).map((a) => (a >= raf ? "#8a2f66" : "#d9a0c2")));
    xmax = xmax || Math.ceil(Math.max(...p.M, ...p.F) / 1000 / 10) * 10;
    return img({ type: "bar", data: { labels, datasets: [{ label: "Men", data: M, backgroundColor: cm, barPercentage: 1, categoryPercentage: 1 }, { label: "Women", data: F, backgroundColor: cf, barPercentage: 1, categoryPercentage: 1 }] },
      options: { indexAxis: "y", plugins: { title: { display: true, text: `${year} (${p.type === "observed" ? "observed" : "projection"})`, color: C.ink, font: { size: 12 } }, legend: { display: false } },
        scales: { x: { stacked: true, min: -xmax, max: xmax, ticks: { callback: (v) => Math.abs(v), font: { size: 9 } }, title: { display: true, text: "thousand persons (men left, women right)", font: { size: 9 } } },
          y: { stacked: true, ticks: { autoSkip: false, callback: (v, i) => (i % 10 === 0 ? labels[i] : ""), font: { size: 9 } }, grid: { display: false } } } } }, w, h);
  };
  const SCEN_COLORS = { baseline: "#1f2e3b", custom: "#c07f1d", optimistic: "#2c5e4c", pessimistic: "#b13a2f" };
  X.chartScenario = (sr, metric, title, w = 420, h = 300) => {
    const base = sr.scenarios[0], years = base.series.years, last = base.last_hist_year;
    const ds = [{ label: "observed", data: years.map((y, i) => (y <= last ? base.series[metric][i] : null)), borderColor: C.observed, borderWidth: 2, pointRadius: 0 }];
    sr.scenarios.forEach((sc) => ds.push({ label: sc.name.slice(0, 44), data: sc.series.years.map((y, i) => (y >= last ? sc.series[metric][i] : null)), borderColor: SCEN_COLORS[sc.id] || "#666", borderWidth: sc.id === "custom" ? 2.6 : 1.6, borderDash: sc.id === "optimistic" || sc.id === "pessimistic" ? [6, 4] : [], pointRadius: 0 }));
    return img({ type: "line", data: { labels: years, datasets: ds }, options: lineOpts(title, metric === "dependency" ? (v) => v.toFixed(0) : (v) => `${(v / 1e6).toFixed(1)} M`) }, w, h);
  };
  X.chartImpacts = (sr, w = 800) => {
    const imp = sr.impacts; if (!imp.length) return null;
    const col = { positive: "#2c5e4c", negative: "#b13a2f", neutral: "#8a96a3" };
    return img({ type: "bar", data: { labels: imp.map((i) => i.label), datasets: [{ label: `change in recipients per 100 aged 15–64, ${sr.impact_year}`, data: imp.map((i) => i.d_dependency), backgroundColor: imp.map((i) => col[i.category]) }] },
      options: { indexAxis: "y", plugins: { legend: { display: true, position: "bottom" } }, scales: { x: { grid: { color: C.grid } }, y: { ticks: { font: { size: 10 } } } } } }, w, Math.max(160, imp.length * 30 + 70));
  };

  // ------------------------------------------------------------------ zip of CSV files
  X.csvBundle = async (res, s, ds) => {
    const JSZip = await X.loadLib("jszip"), z = new JSZip();
    z.file("forecast_yearly.csv", X.csv(X.resultsFrame(res), false));
    z.file("milestones.csv", X.csv(X.milestonesFrame(res), false));
    z.file("model_metrics.csv", X.csv(X.metricsFrame(res), false));
    z.file("settings.csv", X.csv(X.settingsFrame(s), false));
    z.file("input_data.csv", X.csv(X.dataFrame(ds), false));
    z.file("population_yearly.csv", X.csv(X.populationFrame(res), false));
    z.file("pensioners_by_sex.csv", X.csv(X.sexFrame(res), false));
    z.file("population_by_age_sex.csv", X.csv(X.ageStructureFrame(res), false));
    z.file("population_validation_2016_2026.csv", X.csv(X.validationFrame(res), false));
    return z.generateAsync({ type: "blob", compression: "DEFLATE" });
  };

  // ------------------------------------------------------------------ Excel
  const b64 = (dataUrl) => dataUrl.split(",")[1];
  const addSheet = (wb, name, frame, numFmtSmall = "0.000") => {
    const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
    ws.addRow(frame.cols);
    frame.rows.forEach((r) => ws.addRow(frame.cols.map((c) => (r[c] === undefined || (typeof r[c] === "number" && !Number.isFinite(r[c])) ? null : r[c]))));
    styleSheet(ws, frame, numFmtSmall);
    return ws;
  };
  const styleSheet = (ws, frame, numFmtSmall, headerRow = 1) => {
    const head = ws.getRow(headerRow);
    head.eachCell((c) => { c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2E3B" } }; c.alignment = { vertical: "middle", wrapText: true }; });
    frame.cols.forEach((c, j) => {
      const vals = frame.rows.slice(0, 60).map((r) => r[c]);
      const w = Math.max(String(c).length, ...vals.map((v) => (v === null || v === undefined ? 0 : String(typeof v === "number" ? Math.round(v * 1000) / 1000 : v).length)));
      ws.getColumn(j + 1).width = Math.min(Math.max(10, w + 2), 60);
      ws.getColumn(j + 1).eachCell({ includeEmpty: false }, (cell, rn) => { if (rn > headerRow && typeof cell.value === "number" && !Number.isInteger(cell.value)) cell.numFmt = Math.abs(cell.value) >= 1000 ? "#,##0" : numFmtSmall; });
    });
  };
  const putImage = (wb, ws, dataUrl, col, row, w, h) => { if (!dataUrl) return; const id = wb.addImage({ base64: b64(dataUrl), extension: "png" }); ws.addImage(id, { tl: { col, row }, ext: { width: w, height: h } }); };
  const blobXlsx = async (wb) => new Blob([await wb.xlsx.writeBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  X.xlsx = async (res, s, ds) => {
    const ExcelJS = await X.loadLib("exceljs"), wb = new ExcelJS.Workbook();
    wb.creator = "Pension Simulator"; wb.created = new Date();
    const sum = { cols: ["item", "value"], rows: [["Title", "Hungarian pensioner simulation"], ["Generated", U.nowText()], ["Target", res.target_label], ["Last observed year", res.last_actual.year], ["Last observed value", res.last_actual.value], ["Forecast horizon", `${res.future_years[0]}–${res.future_years[res.future_years.length - 1]}`], ["Ensemble method", s.ensemble_mode], ["Denominator for ratio models", res.denominator]].map(([item, value]) => ({ item, value })) };
    const ws = addSheet(wb, "Summary", sum);
    const mf = X.milestonesFrame(res);
    ws.addRow([]); ws.addRow([]);
    const hr = ws.rowCount + 1; ws.addRow(mf.cols); mf.rows.forEach((r) => ws.addRow(mf.cols.map((c) => r[c])));
    ws.getRow(hr).eachCell((c) => { c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2E3B" } }; });
    for (let r = hr + 1; r <= ws.rowCount; r++) ws.getRow(r).eachCell((c) => { if (typeof c.value === "number" && !Number.isInteger(c.value)) c.numFmt = Math.abs(c.value) >= 1000 ? "#,##0" : "0.000"; });
    putImage(wb, ws, X.chartMain(res, 760, 360), 10, 1, 760, 360);
    const fc = addSheet(wb, "Forecast", X.resultsFrame(res));
    putImage(wb, fc, X.chartMain(res, 760, 360), X.resultsFrame(res).cols.length + 1, 1, 760, 360);
    addSheet(wb, "Model metrics", X.metricsFrame(res));
    addSheet(wb, "Settings", X.settingsFrame(s));
    addSheet(wb, "Input data", X.dataFrame(ds));
    addSheet(wb, "Data provenance", X.provFrame(ds));
    const sx = addSheet(wb, "Pensioners by sex", X.sexFrame(res));
    putImage(wb, sx, X.chartSex(res, 760, 280), 19, 1, 760, 280);
    const pp = addSheet(wb, "Population", X.populationFrame(res));
    putImage(wb, pp, X.chartPopulation(res, 760, 300), 36, 1, 760, 300);
    putImage(wb, pp, X.chartAgeGroups(res, 760, 280), 36, 18, 760, 280);
    const pyYears = [...new Set([res.population.base_year, ...[1990, 2001, 2030, 2040, 2050, 2060, 2070].filter((y) => y <= s.end_year)])].sort((a, b) => a - b);
    const py = addSheet(wb, "Pyramids", X.pyramidWide(res, pyYears));
    const y2 = s.end_year >= 2050 ? 2050 : s.end_year, xm = pyrMax(res, [res.population.base_year, y2]);
    putImage(wb, py, X.chartPyramid(res, res.population.base_year, 300, 380, xm), pyYears.length * 2 + 2, 1, 300, 380);
    putImage(wb, py, X.chartPyramid(res, y2, 300, 380, xm), pyYears.length * 2 + 7, 1, 300, 380);
    addSheet(wb, "Age structure (long)", X.ageStructureFrame(res));
    addSheet(wb, "Population back-test", X.validationFrame(res));
    addSheet(wb, "Sources", { cols: ["source"], rows: X.SOURCES.map((source) => ({ source })) });
    if (res.warnings.length) addSheet(wb, "Warnings", { cols: ["warning"], rows: res.warnings.map((warning) => ({ warning })) });
    return blobXlsx(wb);
  };
  const pyrMax = (res, years) => Math.ceil(Math.max(...years.flatMap((y) => { const p = res.population.pyramids[y]; return p ? [...p.M, ...p.F] : [0]; })) / 1000 / 10) * 10;

  // ------------------------------------------------------------------ Markdown
  X.md = (res, s) => {
    const L = [];
    L.push(`# Hungarian pensioner simulation – ${res.target_label}\n`);
    L.push(`Generated ${U.nowText()}. Last observed value: **${fmt(res.last_actual.value)}** (January ${res.last_actual.year}).\n`);
    L.push("## Milestones (ensemble)\n", "| Year | Forecast | Lower | Upper | Change vs last observed | Per 1,000 population | Retirement age |", "|---:|---:|---:|---:|---:|---:|---:|");
    res.milestones.forEach((m) => L.push(`| ${m.year} | ${fmt(m.value)} | ${fmt(m.lo)} | ${fmt(m.hi)} | ${sgn(m.change_pct, 1)} % | ${m.per_1000.toFixed(1)} | ${m.retirement_age.toFixed(2)} |`));
    const bs = res.by_sex || {};
    if (bs.available) {
      L.push("\n### By sex\n", "| Year | Men | Women | Women's share |", "|---:|---:|---:|---:|");
      L.push(`| ${bs.hist_years[bs.hist_years.length - 1]} (observed) | ${fmt(bs.men[bs.men.length - 1])} | ${fmt(bs.women[bs.women.length - 1])} | ${bs.share_women_hist[bs.share_women_hist.length - 1].toFixed(1)} % |`);
      res.milestones.forEach((m) => { if (m.men !== null) L.push(`| ${m.year} | ${fmt(m.men)} | ${fmt(m.women)} | ${((m.women / m.value) * 100).toFixed(1)} % |`); });
      const b = bs.backtest;
      L.push(`\nSex split back-test (${b.years[0]}–${b.years[b.years.length - 1]}): women's share error ${b.share_mae_pp.toFixed(2)} percentage points; MAPE men ${b.mape_men.toFixed(2)} %, women ${b.mape_women.toFixed(2)} %.`);
    }
    L.push(`\nInterval level: ${(Number(s.conf_level) * 100).toFixed(0)} %. Ratio models use: ${res.denominator}.\n`);
    L.push("## Model back-test and weights\n", "| Model | Weight | MAE | RMSE | MAPE % | Status |", "|---|---:|---:|---:|---:|---|");
    X.metricsFrame(res).rows.forEach((r) => L.push(`| ${r.model} | ${r.weight.toFixed(3)} | ${fmt(r.mae)} | ${fmt(r.rmse)} | ${fmt(r.mape_pct, 2)} | ${r.status} |`));
    const ok = okModels(res), hs = bs.available;
    L.push("\n## Yearly forecast\n", "| Year | Ensemble | Lower | Upper | " + (hs ? "Men | Women | " : "") + ok.map((k) => SET.MODEL_LABELS[k]).join(" | ") + " |", "|---:|---:|---:|---:|" + (hs ? "---:|---:|" : "") + "---:|".repeat(ok.length));
    res.future_years.forEach((y, i) => L.push(`| ${y} | ${fmt(res.ensemble.pred[i])} | ${fmt(res.ensemble.lo[i])} | ${fmt(res.ensemble.hi[i])} | ${hs ? `${fmt(bs.men_pred[i])} | ${fmt(bs.women_pred[i])} | ` : ""}${ok.map((k) => fmt(res.models[k].pred[i])).join(" | ")} |`));
    const pf = X.populationFrame(res);
    L.push("\n## Population and age structure\n", `Cohort-component projection from the KSH 1 January age structure. ${res.population.assumptions.variants}.\n`);
    L.push("| Year | Type | Population | Men | Women | Low | High | 0–14 % | 15–64 % | 65+ % | 80+ % | 65+ men | 65+ women | Old-age dependency | Median age | Eurostat |", "|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    const sel = new Set([1990, 2001, 2010, 2016, 2020, res.population.base_year, ...U.range(2030, 2071).filter((y) => y % 5 === 0)]);
    pf.rows.filter((r) => sel.has(r.year)).forEach((r) => L.push(`| ${r.year} | ${r.type} | ${fmt(r.total)} | ${fmt(r.male)} | ${fmt(r.female)} | ${fmt(r.total_low)} | ${fmt(r.total_high)} | ${r.share_0_14.toFixed(1)} | ${r.share_15_64.toFixed(1)} | ${r.share_65_plus.toFixed(1)} | ${r.share_80_plus.toFixed(1)} | ${fmt(r.age_65_plus_m)} | ${fmt(r.age_65_plus_f)} | ${r.old_age_dependency.toFixed(1)} | ${r.median_age.toFixed(1)} | ${fmt(r.eurostat_projection)} |`));
    const v = res.population.validation;
    if (v && v.rows) {
      L.push(`\n### Population back-test (${v.period})\n`, "| Indicator | Projected | Observed (KSH) | Error |", "|---|---:|---:|---:|");
      v.rows.forEach((r) => L.push(`| ${r.indicator} | ${fmt(r.projected)} | ${fmt(r.observed)} | ${sgn(r.error_pct, 2)} % |`));
      L.push(`\nMean absolute error across single ages: ${v.age_mape.toFixed(2)} %.`);
    }
    L.push("\n## Settings\n", "| Group | Setting | Key | Value |", "|---|---|---|---|");
    SET.toRows(s).forEach((r) => L.push(`| ${r.group} | ${r.label} | \`${r.key}\` | ${r.value} |`));
    if (res.warnings.length) { L.push("\n## Warnings\n"); res.warnings.forEach((w) => L.push(`- ${w}`)); }
    L.push("\n## Data sources\n"); X.SOURCES.forEach((x) => L.push(`- ${x}`));
    L.push("\n## Observed history\n", "| Year | Observed |", "|---:|---:|");
    res.hist_years.forEach((y, i) => L.push(`| ${y} | ${fmt(res.hist_values[i])} |`));
    return L.join("\n") + "\n";
  };

  // ------------------------------------------------------------------ PDF
  const pdfText = (t) => String(t).replace(/α/g, "alpha").replace(/φ/g, "phi");
  const newPdf = async (landscape = false) => {
    const { jsPDF } = await X.loadLib("jspdf");
    await X.loadLib("autotable");
    const font = await X.loadLib("pdffont");
    const doc = new jsPDF({ unit: "mm", format: "a4", orientation: landscape ? "landscape" : "portrait" });
    doc.addFileToVFS("Archivo-Regular.ttf", font.normal); doc.addFont("Archivo-Regular.ttf", "Archivo", "normal");
    doc.addFileToVFS("Archivo-Bold.ttf", font.bold); doc.addFont("Archivo-Bold.ttf", "Archivo", "bold");
    doc.setFont("Archivo", "normal");
    return doc;
  };
  const pdfKit = (doc) => {
    const W = doc.internal.pageSize.getWidth(), Hh = doc.internal.pageSize.getHeight(), M = 14;
    const k = { W, H: Hh, M, y: M, cw: W - 2 * M };
    k.space = (need) => { if (k.y + need > Hh - 14) { doc.addPage(); k.y = M; } };
    k.h1 = (t) => { doc.setFont("Archivo", "bold"); doc.setFontSize(15); const l = doc.splitTextToSize(pdfText(t), k.cw); k.space(l.length * 6.5); doc.text(l, M, k.y + 5); k.y += l.length * 6.5 + 2; };
    k.h2 = (t) => { k.space(14); doc.setFont("Archivo", "bold"); doc.setFontSize(11.5); doc.setTextColor(31, 46, 59); doc.text(pdfText(t), M, k.y + 6); k.y += 9; };
    k.p = (t, size = 9) => { doc.setFont("Archivo", "normal"); doc.setFontSize(size); doc.setTextColor(30, 30, 30); const l = doc.splitTextToSize(pdfText(t), k.cw); const lh = size * 0.42; k.space(l.length * lh + 2); doc.text(l, M, k.y + lh); k.y += l.length * lh + 2.5; };
    k.img = (url, w, h, x = M) => { if (!url) return; k.space(h + 2); doc.addImage(url, "JPEG", x, k.y, w, h); k.y += h + 3; };
    k.imgs = (urls, w, h) => { k.space(h + 2); let x = M; urls.forEach((u) => { if (u) { doc.addImage(u, "JPEG", x, k.y, w, h); x += w + 3; } }); k.y += h + 3; };
    k.table = (head, body, opts = {}) => {
      doc.autoTable({ head: [head.map(pdfText)], body: body.map((r) => r.map((c) => pdfText(c ?? ""))), startY: k.y, margin: { left: M, right: M },
        styles: { font: "Archivo", fontSize: opts.font || 7.5, cellPadding: 1.2, lineColor: [201, 209, 216], lineWidth: 0.15 },
        headStyles: { fillColor: [31, 46, 59], textColor: 255, fontStyle: "bold" }, alternateRowStyles: { fillColor: [241, 244, 246] },
        columnStyles: Object.fromEntries(head.map((_, i) => [i, { halign: i >= (opts.leftCols || 1) ? "right" : "left" }])), ...opts.extra });
      k.y = doc.lastAutoTable.finalY + 4;
    };
    k.footer = (text) => { const n = doc.getNumberOfPages(); for (let i = 1; i <= n; i++) { doc.setPage(i); doc.setFont("Archivo", "normal"); doc.setFontSize(7); doc.setTextColor(93, 107, 121); doc.text(text, M, Hh - 8); doc.text(`Page ${i}`, W - M, Hh - 8, { align: "right" }); } };
    return k;
  };
  const asJpeg = (fn) => async (...a) => { IMG_TYPE = "image/jpeg"; try { return await fn(...a); } finally { IMG_TYPE = "image/png"; } };
  X.pdf = asJpeg(async (res, s) => {
    const doc = await newPdf(), k = pdfKit(doc);
    doc.setProperties({ title: "Hungarian pensioner simulation" });
    k.h1(`Hungarian pensioner simulation – ${res.target_label}`);
    k.p(`Generated ${U.nowText()}. Last observed value ${fmt(res.last_actual.value)} (January ${res.last_actual.year}, KSH). Ensemble of ${Object.keys(res.weights).length} models, weighting: ${s.ensemble_mode}; ${(Number(s.conf_level) * 100).toFixed(0)} % prediction intervals.`);
    k.img(X.chartMain(res, 900, 430), k.cw, k.cw * 430 / 900);
    k.h2("Milestones");
    k.table(["Year", "Forecast", "Lower", "Upper", "Change", "Per 1,000 pop.", "Ret. age"], res.milestones.map((m) => [m.year, fmt(m.value), fmt(m.lo), fmt(m.hi), `${sgn(m.change_pct, 1)} %`, m.per_1000.toFixed(1), m.retirement_age.toFixed(2)]), { font: 8.5 });
    const bs = res.by_sex;
    if (bs && bs.available) {
      k.h2("By sex");
      k.img(X.chartSex(res, 900, 300), k.cw, k.cw * 300 / 900);
      k.table(["Year", "Men", "Women", "Women's share"], [[`${bs.hist_years[bs.hist_years.length - 1]} obs.`, fmt(bs.men[bs.men.length - 1]), fmt(bs.women[bs.women.length - 1]), `${bs.share_women_hist[bs.share_women_hist.length - 1].toFixed(1)} %`], ...res.milestones.map((m) => [m.year, fmt(m.men), fmt(m.women), `${((m.women / m.value) * 100).toFixed(1)} %`])], { font: 8.5 });
      const b = bs.backtest;
      k.p(`Sex-specific ratio models on the population at or above each sex's retirement age, reconciled to the ensemble. Back-test ${b.years[0]}–${b.years[b.years.length - 1]}: women's share error ${b.share_mae_pp.toFixed(2)} pp, MAPE men ${b.mape_men.toFixed(2)} %, women ${b.mape_women.toFixed(2)} %.`, 7.5);
    }
    k.h2("Model back-test and ensemble weights");
    k.table(["Model", "Weight", "MAE", "RMSE", "MAPE %", "Status"], X.metricsFrame(res).rows.map((r) => [r.model, r.weight.toFixed(3), fmt(r.mae), fmt(r.rmse), fmt(r.mape_pct, 2), String(r.status).slice(0, 80)]), { extra: { columnStyles: { 0: { halign: "left" }, 5: { halign: "left", cellWidth: 50 } } } });
    if (res.warnings.length) { k.h2("Warnings"); res.warnings.forEach((w) => k.p("• " + w, 7.5)); }
    doc.addPage(); k.y = k.M;
    k.h2("Yearly forecast");
    const short = { arima: "ARIMA", ets: "Holt", structural: "Ratio", rf: "RF", gb: "GBoost", ridge: "Ridge", mlp: "MLP" }, ok = okModels(res);
    k.table(["Year", "Ensemble", "Lower", "Upper", ...ok.map((x) => short[x])], res.future_years.map((y, i) => [y, fmt(res.ensemble.pred[i]), fmt(res.ensemble.lo[i]), fmt(res.ensemble.hi[i]), ...ok.map((x) => fmt(res.models[x].pred[i]))]), { font: 7 });
    doc.addPage(); k.y = k.M;
    const a = res.population.assumptions;
    k.h2("Population and age structure");
    k.p(`Cohort-component projection from the KSH age structure of 1 January ${res.population.base_year}. Fertility ${a.tfr_start.toFixed(2)} → ${a.tfr_target.toFixed(2)} by ${a.tfr_target_year}, net migration ${fmt(a.net_migration)} a year, life expectancy at birth from ${a.e0_m_start.toFixed(1)} (men) and ${a.e0_f_start.toFixed(1)} (women). Shaded band: ${a.variants}.`);
    const half = (k.cw - 3) / 2;
    k.imgs([X.chartPopulation(res, 600, 330), X.chartAgeGroups(res, 600, 330)], half, half * 330 / 600);
    const pys = [res.population.base_year, ...[2040, 2050, 2070].filter((y) => y <= s.end_year).slice(0, 2)], xm = pyrMax(res, pys), third = (k.cw - 6) / 3;
    k.imgs(pys.map((y) => X.chartPyramid(res, y, 300, 380, xm)), third, third * 380 / 300);
    k.p("Darker bars: at or above the retirement age of that year.", 7.5);
    const pf = X.populationFrame(res), want = new Set([1990, 2001, res.population.base_year, 2030, 2040, 2050, 2060, 2070]);
    k.table(["Year", "Population", "Men", "Women", "Low", "High", "0–14 %", "65+ %", "65+ men", "65+ women", "OADR", "Median"], pf.rows.filter((r) => want.has(r.year)).map((r) => [r.year, fmt(r.total), fmt(r.male), fmt(r.female), fmt(r.total_low), fmt(r.total_high), r.share_0_14.toFixed(1), r.share_65_plus.toFixed(1), fmt(r.age_65_plus_m), fmt(r.age_65_plus_f), r.old_age_dependency.toFixed(1), r.median_age.toFixed(1)]), { font: 6.5 });
    const v = res.population.validation;
    if (v && v.rows) {
      k.h2(`Back-test of the projection engine, ${v.period}`);
      k.table(["Indicator", "Projected", "Observed (KSH)", "Error"], v.rows.map((r) => [r.indicator, fmt(r.projected), fmt(r.observed), `${sgn(r.error_pct, 2)} %`]));
      k.p(`Mean absolute error across single ages 0–90+: ${v.age_mape.toFixed(2)} %. Inputs: observed TFR, life expectancy by sex and net migration implied by KSH totals.`, 7.5);
    }
    doc.addPage(); k.y = k.M;
    k.h2("Settings used");
    k.table(["Group", "Setting", "Value"], SET.toRows(s).map((r) => [r.group, r.label, String(r.value)]), { font: 7, leftCols: 3 });
    k.h2("Data sources");
    X.SOURCES.forEach((x) => k.p("• " + x, 7.5));
    k.p("Method notes: models are back-tested on the most recent hold-out years; the ensemble combines successful models. Intervals for non-ARIMA models are approximations based on relative residual dispersion growing with the horizon. Retirement ages are an approximate gender-averaged legislated schedule. Simulation results are scenarios, not official forecasts.", 7.5);
    k.footer("Hungarian pensioner simulation – KSH & Eurostat data");
    return doc.output("blob");
  });

  // ------------------------------------------------------------------ scenario exports
  const SCEN_METRICS = ["pensioners", "men", "women", "population", "dependency", "share_65_plus", "retirement_age"];
  X.scenarioSeriesFrame = (sr) => {
    const rows = [];
    sr.scenarios.forEach((sc) => sc.series.years.forEach((y, i) => rows.push({ scenario: sc.name, year: y, type: y <= sc.last_hist_year ? "observed" : "forecast", ...Object.fromEntries(SCEN_METRICS.map((m) => [m, sc.series[m][i]])), lower: sc.series.lower[i], upper: sc.series.upper[i] })));
    return { cols: ["scenario", "year", "type", ...SCEN_METRICS, "lower", "upper"], rows };
  };
  X.scenarioMilestonesFrame = (sr) => {
    const cols = ["scenario", "year", ...SCEN_METRICS.flatMap((m) => [m, `${m}_diff`])];
    return { cols, rows: sr.scenarios.flatMap((sc) => sc.milestones.map((m) => ({ scenario: sc.name, ...m }))) };
  };
  X.scenarioImpactsFrame = (sr) => {
    const y = sr.impact_year, cols = ["parameter", "category", "value", "unit", `change in burden ${y}`, "average change in burden", `change in recipients ${y}`, `change in population ${y}`, "measured", "check"];
    return { cols, rows: sr.impacts.map((i) => ({ parameter: i.label, category: i.category, value: i.value, unit: i.unit, [`change in burden ${y}`]: i.d_dependency, "average change in burden": i.d_dependency_avg, [`change in recipients ${y}`]: i.d_pensioners, [`change in population ${y}`]: i.d_population, measured: i.observed, check: i.status })) };
  };
  X.scenarioChangesFrame = (sr) => ({ cols: ["scenario", "setting", "key", "baseline_value", "scenario_value"], rows: sr.scenarios.flatMap((sc) => sc.changes.map((c) => ({ scenario: sc.name, setting: c.label, key: c.key, baseline_value: c.baseline, scenario_value: c.scenario }))) });
  X.scenarioSelectionFrame = (sr) => {
    const by = PS.scenarios.BY_KEY;
    return { cols: ["parameter", "key", "category", "value", "unit"], rows: Object.entries(sr.selection).filter(([k]) => by[k]).map(([k, v]) => ({ parameter: by[k].label, key: k, category: by[k].category, value: v, unit: by[k].unit })) };
  };
  X.scenarioXlsx = async (sr) => {
    const ExcelJS = await X.loadLib("exceljs"), wb = new ExcelJS.Workbook();
    const cmp = addSheet(wb, "Comparison", X.scenarioMilestonesFrame(sr), "0.00");
    addSheet(wb, "Selected parameters", X.scenarioSelectionFrame(sr), "0.00");
    const im = addSheet(wb, "Parameter impacts", X.scenarioImpactsFrame(sr), "0.00");
    addSheet(wb, "Setting changes", X.scenarioChangesFrame(sr), "0.00");
    addSheet(wb, "Yearly series", X.scenarioSeriesFrame(sr), "0.00");
    addSheet(wb, "Baseline settings", X.settingsFrame(sr.base_settings), "0.00");
    addSheet(wb, "Notes", { cols: ["category", "meaning"], rows: [{ category: "positive", meaning: "lowers the pension burden" }, { category: "negative", meaning: "raises the pension burden" }, { category: "neutral", meaning: "mainly shifts structure or timing" }, { category: "note", meaning: sr.metric_note }] });
    putImage(wb, cmp, X.chartScenario(sr, "pensioners", "Recipients", 520, 320), 17, 1, 520, 320);
    putImage(wb, cmp, X.chartScenario(sr, "dependency", "Recipients per 100 aged 15–64", 520, 320), 17, 18, 520, 320);
    const ic = X.chartImpacts(sr, 720); if (ic) putImage(wb, im, ic, 11, 1, 720, Math.max(160, sr.impacts.length * 30 + 70));
    return blobXlsx(wb);
  };
  X.scenarioMd = (sr) => {
    const L = [`# Scenario comparison – ${sr.name}\n`, `Generated ${U.nowText()}. ${sr.metric_note}\n`, "## Selected parameters\n", "| Category | Parameter | Value | Unit |", "|---|---|---:|---|"];
    X.scenarioSelectionFrame(sr).rows.forEach((r) => L.push(`| ${r.category} | ${r.parameter} | ${+r.value} | ${r.unit} |`));
    L.push("\n## Comparison\n", "| Scenario | Year | Recipients | vs baseline | Men | Women | Population | Recipients per 100 aged 15–64 | vs baseline | Retirement age |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    sr.scenarios.forEach((sc) => sc.milestones.forEach((m) => L.push(`| ${sc.name} | ${m.year} | ${fmt(m.pensioners)} | ${fmt(m.pensioners_diff)} | ${fmt(m.men)} | ${fmt(m.women)} | ${fmt(m.population)} | ${fmt(m.dependency, 1)} | ${fmt(m.dependency_diff, 2)} | ${fmt(m.retirement_age, 2)} |`)));
    if (sr.impacts.length) {
      L.push(`\n## Parameter impacts (${sr.impact_mode === "within" ? "within the scenario" : "each on its own"})\n`, `| Parameter | Category | Burden change ${sr.impact_year} | Average change | Recipients ${sr.impact_year} | Check |`, "|---|---|---:|---:|---:|---|");
      sr.impacts.forEach((i) => L.push(`| ${i.label} | ${i.category} | ${sgn(i.d_dependency, 2)} | ${sgn(i.d_dependency_avg, 2)} | ${sgn(i.d_pensioners, 0)} | ${i.status} |`));
    }
    L.push("\n## Setting changes\n", "| Scenario | Setting | Baseline | Scenario |", "|---|---|---|---|");
    sr.scenarios.forEach((sc) => sc.changes.forEach((c) => L.push(`| ${sc.name} | ${c.label} | ${c.baseline} | ${c.scenario} |`)));
    return L.join("\n") + "\n";
  };
  X.scenarioPdf = asJpeg(async (sr) => {
    const doc = await newPdf(true), k = pdfKit(doc);
    doc.setProperties({ title: "Scenario comparison" });
    k.h1(`Scenario comparison – ${sr.name}`);
    k.p(`Generated ${U.nowText()}. ${sr.metric_note}`, 7.5);
    const w3 = (k.cw - 6) / 3;
    k.imgs([X.chartScenario(sr, "pensioners", "Recipients"), X.chartScenario(sr, "dependency", "Recipients per 100 aged 15–64"), X.chartScenario(sr, "population", "Population")], w3, w3 * 300 / 420);
    k.h2("Comparison");
    k.table(["Scenario", "Year", "Recipients", "vs baseline", "Men", "Women", "Population", "Per 100 aged 15–64", "vs baseline", "Ret. age"], sr.scenarios.flatMap((sc) => sc.milestones.map((m) => [sc.name.slice(0, 40), m.year, fmt(m.pensioners), fmt(m.pensioners_diff), fmt(m.men), fmt(m.women), fmt(m.population), fmt(m.dependency, 1), fmt(m.dependency_diff, 2), fmt(m.retirement_age, 2)])), { leftCols: 1 });
    const sel = X.scenarioSelectionFrame(sr).rows;
    if (sel.length) { k.h2("Selected parameters"); k.table(["Category", "Parameter", "Value", "Unit"], sel.map((r) => [r.category, r.parameter, String(+r.value), r.unit]), { leftCols: 2 }); }
    const ic = X.chartImpacts(sr, 800);
    if (ic) {
      k.h2(`Parameter impacts, ${sr.impact_mode === "within" ? "within the scenario" : "each on its own"}`);
      const hpx = Math.max(160, sr.impacts.length * 30 + 70);
      k.img(ic, 190, 190 * hpx / 800);
      k.table(["Parameter", "Category", `Burden ${sr.impact_year}`, "Average", `Recipients ${sr.impact_year}`, "Check"], sr.impacts.map((i) => [i.label, i.category, sgn(i.d_dependency, 2), sgn(i.d_dependency_avg, 2), sgn(i.d_pensioners, 0), i.status]), { leftCols: 2, extra: { columnStyles: { 0: { halign: "left" }, 1: { halign: "left" }, 5: { halign: "left" } } } });
    }
    k.footer("Pension Simulator – scenario comparison");
    return doc.output("blob");
  });
})(globalThis);
