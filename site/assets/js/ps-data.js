/* Pension Simulator – data layer.
   Layers, lowest to highest priority (same as the desktop version):
     1. bundled KSH tables (ps-defaults.js)
     2. official data downloaded by the site's PHP service (api.php), shared by all visitors
     3. the visitor's own data (kept in their browser)                                    */
(function (G) {
  "use strict";
  const PS = G.PS, U = PS.util, D = G.PS_DEFAULTS;
  const DATA = (PS.data = {});
  const COLUMNS = (DATA.COLUMNS = D.columns);
  DATA.LABELS = D.columnLabels;
  const NUMERIC_PROJ = ["population", "share_65plus", "pop_65plus"];

  // ------------------------------------------------------------------ official data (from api.php)
  // shape: {ksh_pensioners:[rows], ksh_population:[rows], ksh_ages:{M:{year:[91]},F:{}},
  //         eurostat_hist:{M:{year:[101]},F:{}}, eurostat_proj:{VARIANT:{code,M:{},F:{}}}}, meta
  DATA.official = null;
  DATA.meta = null;
  DATA.setOfficial = (payload) => {
    DATA.official = payload && payload.data ? payload.data : null;
    DATA.meta = payload && payload.meta ? payload.meta : null;
  };

  // ------------------------------------------------------------------ the visitor's own data
  const STORE_KEY = "pensim.userData.v1";
  let memUser = [];
  DATA.loadUser = () => {
    try { const t = G.localStorage && G.localStorage.getItem(STORE_KEY); if (t) return JSON.parse(t); } catch (e) { /* storage blocked */ }
    return memUser.slice();
  };
  DATA.saveUser = (rows) => {
    rows = rows.filter((r) => COLUMNS.some((c) => U.isNum(r[c]))).sort((a, b) => a.year - b.year)
      .map((r) => { const o = { year: r.year }; COLUMNS.forEach((c) => { if (U.isNum(r[c])) o[c] = r[c]; }); return o; });
    memUser = rows;
    try { G.localStorage && G.localStorage.setItem(STORE_KEY, JSON.stringify(rows)); } catch (e) { /* keep in memory */ }
  };
  DATA.resetUser = () => { memUser = []; try { G.localStorage && G.localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ } };
  DATA.mergeUser = (newRows, mode = "override") => {
    const cur = new Map(DATA.loadUser().map((r) => [r.year, { ...r }]));
    for (const r of newRows) {
      const old = cur.get(r.year) || { year: r.year };
      for (const c of COLUMNS) {
        if (!(c in r)) continue;
        if (mode === "override") { if (U.isNum(r[c])) old[c] = r[c]; else if (r[c] === null && r.__clear) delete old[c]; }
        else if (!U.isNum(old[c]) && U.isNum(r[c])) old[c] = r[c];
      }
      cur.set(r.year, old);
    }
    DATA.saveUser([...cur.values()]);
  };

  // ------------------------------------------------------------------ uploads
  const ALIASES = D.aliases;
  const cleanNum = (v) => {
    if (v === null || v === undefined) return NaN;
    if (typeof v === "number") return v;
    const s = String(v).replace(/[\s  ]/g, "").replace(",", ".");
    if (s === "") return NaN;
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  };
  // header: array of names; rows: array of arrays (strings or numbers)
  DATA.tableToRows = (header, rows) => {
    const cols = header.map((c) => { const k = String(c).trim().toLowerCase().replace(/ /g, "_"); return ALIASES[k] || k; });
    const yi = cols.indexOf("year");
    if (yi < 0) throw new Error("The file needs a 'year' column.");
    const keep = COLUMNS.filter((c) => cols.includes(c));
    if (!keep.length) throw new Error("No known data columns found. Use: " + COLUMNS.join(", "));
    const out = [];
    for (const r of rows) {
      const y = cleanNum(r[yi]);
      if (!Number.isFinite(y)) continue;
      const o = { year: Math.trunc(y) };
      for (const c of keep) o[c] = cleanNum(r[cols.indexOf(c)]);
      out.push(o);
    }
    return { rows: out, columns: keep };
  };
  DATA.parseCsvText = (text) => {
    text = text.replace(/^﻿/, "");
    const sep = (text.match(/;/g) || []).length > (text.match(/,/g) || []).length ? ";" : ",";
    const all = PS.csv.parse(text, sep);
    if (!all.length) throw new Error("The file is empty.");
    return DATA.tableToRows(all[0], all.slice(1));
  };

  // ------------------------------------------------------------------ age tables
  // ages: {year: [values by age]}; returns aggregates like aggregates_from_ages()
  const sumFrom = (arr, a0) => { let s = 0; for (let a = a0; a < arr.length; a++) s += arr[a] || 0; return s; };
  DATA.popAtOrAbove = (arr, age) => {
    const lo = Math.floor(age), frac = age - lo;
    let s = sumFrom(arr, lo + (frac > 0 ? 1 : 0));
    if (frac > 0) s += (1 - frac) * (arr[lo] || 0);
    return s;
  };
  const totalMatrix = (bySex) => {
    if (!bySex || !bySex.M || !bySex.F) return null;
    const out = {};
    for (const y of Object.keys(bySex.M)) {
      if (!bySex.F[y]) continue;
      out[+y] = bySex.M[y].map((v, i) => (v || 0) + (bySex.F[y][i] || 0));
    }
    return out;
  };
  DATA.agesHistTotal = () => totalMatrix(DATA.official && DATA.official.eurostat_hist);
  DATA.agesProjTotal = (variant) => {
    const p = DATA.official && DATA.official.eurostat_proj && DATA.official.eurostat_proj[variant];
    return totalMatrix(p);
  };
  const aggregates = (ages) => Object.keys(ages).map(Number).sort((a, b) => a - b).map((y) => {
    const arr = ages[y], tot = U.sum(arr.map((v) => v || 0)), p65 = DATA.popAtOrAbove(arr, 65);
    return { year: y, population: tot, pop_65plus: p65, share_65plus: U.roundHalfEven(p65 / tot * 100, 3) };
  });

  // ------------------------------------------------------------------ assembly (build_dataset)
  DATA.buildDataset = (variant = "BSL") => {
    const off = DATA.official || {};
    const dh = D.defaultHistory, dp = D.defaultProjection;
    const T = new Map(), P = new Map();     // year -> {col: value}, year -> {col: provenance}
    const baseCols = new Set();
    for (const r of [...dh, ...dp]) {
      const row = T.get(r.year) || {};
      for (const c of COLUMNS) if (c in r) { baseCols.add(c); row[c] = U.isNum(r[c]) ? r[c] : (row[c] ?? NaN); }
      T.set(r.year, row);
    }
    // base provenance: "default" for every base column (even empty cells), like the Python version
    for (const y of T.keys()) { const p = {}; baseCols.forEach((c) => { p[c] = "default"; }); P.set(y, p); }
    const ensure = (y) => { if (!T.has(y)) { T.set(y, {}); P.set(y, {}); } };
    const baseRow = (y) => { const r = dh.concat(dp).find((x) => x.year === y); return r; };

    const layers = [];
    if (off.ksh_pensioners && off.ksh_pensioners.length) layers.push(["KSH (online)", off.ksh_pensioners]);
    if (off.ksh_population && off.ksh_population.length) layers.push(["KSH (online)", off.ksh_population]);
    const agesHist = DATA.agesHistTotal(), agesProj = DATA.agesProjTotal(variant);
    if (agesHist) layers.push(["Eurostat demo_pjan (gap fill)", aggregates(agesHist)]);
    if (agesProj) {
      const lastHistEs = agesHist ? U.max(Object.keys(agesHist).map(Number)) : 2026;
      let aggp = aggregates(agesProj);
      const anchor = U.max(dh.map((r) => r.year));
      const row = aggp.find((r) => r.year === anchor), ref = baseRow(anchor);
      if (row && ref && U.isNum(ref.population)) {
        const kshP65 = ref.population * ref.share_65plus / 100;
        const fPop = ref.population / row.population, f65 = kshP65 / row.pop_65plus;
        aggp = aggp.map((r) => { const pop = r.population * fPop, p65 = r.pop_65plus * f65; return { year: r.year, population: pop, pop_65plus: p65, share_65plus: p65 / pop * 100 }; });
      }
      aggp = aggp.filter((r) => r.year > Math.max(lastHistEs, anchor));
      layers.push([`Eurostat projection ${variant}`, aggp]);
    }
    for (const [name, rows] of layers) {
      const gapOnly = name.includes("gap fill");
      for (const r of rows) {
        ensure(r.year);
        const row = T.get(r.year), pr = P.get(r.year);
        for (const c of COLUMNS) {
          if (!(c in r) || !U.isNum(r[c])) continue;
          if (gapOnly && U.isNum(row[c])) continue;
          row[c] = r[c]; pr[c] = name;
        }
      }
    }
    for (const r of DATA.loadUser()) {
      ensure(r.year);
      for (const c of COLUMNS) if (U.isNum(r[c])) { T.get(r.year)[c] = r[c]; P.get(r.year)[c] = "user"; }
    }
    const years = [...T.keys()].sort((a, b) => a - b);
    for (const y of years) { const row = T.get(y), pr = P.get(y); for (const c of COLUMNS) { if (!U.isNum(row[c])) row[c] = NaN; if (pr[c] === undefined) pr[c] = ""; } }

    // derive 65+ population / share where one of them is missing
    for (const y of years) {
      const r = T.get(y), p = P.get(y);
      if (U.nan(r.pop_65plus) && U.isNum(r.population) && U.isNum(r.share_65plus)) { r.pop_65plus = r.population * r.share_65plus / 100; p.pop_65plus = "derived"; }
    }
    for (const y of years) {
      const r = T.get(y), p = P.get(y);
      if (U.nan(r.share_65plus) && U.isNum(r.population) && U.isNum(r.pop_65plus)) { r.share_65plus = r.pop_65plus / r.population * 100; p.share_65plus = "derived"; }
    }
    // last observed year of the recipient series defines "history"
    const lastHist = U.max(years.filter((y) => U.isNum(T.get(y).pensioners_total)));
    const hy = years.filter((y) => y <= lastHist);
    for (const c of ["population", "share_65plus", "pop_65plus", "life_expectancy", "retirement_age"]) {
      const col = hy.map((y) => T.get(y)[c]);
      const nGood = col.filter(U.isNum).length;
      if (nGood >= 2 && col.some(U.nan)) {
        const filled = U.ffill(U.interpolate(col, "inside", hy));
        hy.forEach((y, i) => { if (U.nan(col[i]) && U.isNum(filled[i])) { T.get(y)[c] = filled[i]; P.get(y)[c] = "interpolated"; } });
      }
    }
    const ds = {
      years, T, P, lastHist, hasAgeDetail: !!(agesHist && agesProj),
      agesHist, agesProj, refresh: DATA.meta, variant,
    };
    // intercensal years: the 65+ population from the cohort-interpolated age structure
    try {
      const totals = new Map(hy.map((y) => [y, T.get(y).population]));
      const ha = PS.population.completeHistory(totals);
      for (const y of ha.years) {
        if (!T.has(y)) continue;
        const p = P.get(y);
        if (["interpolated", "derived"].includes(p.pop_65plus) && p.share_65plus === "interpolated") {
          const p65 = sumFrom(ha.ages.M.get(y), 65) + sumFrom(ha.ages.F.get(y), 65);
          T.get(y).pop_65plus = p65; T.get(y).share_65plus = p65 / T.get(y).population * 100;
          p.pop_65plus = p.share_65plus = "cohort-interpolated";
        }
      }
    } catch (e) { /* keep the interpolated values */ }
    return ds;
  };
  // helpers on a dataset
  DATA.col = (ds, c) => ds.years.map((y) => ds.T.get(y)[c]);
  DATA.tableRows = (ds) => ds.years.map((y) => ({ year: y, ...Object.fromEntries(COLUMNS.map((c) => [c, U.isNum(ds.T.get(y)[c]) ? ds.T.get(y)[c] : null])) }));
  DATA.provRows = (ds) => ds.years.map((y) => ({ year: y, ...ds.P.get(y) }));
  DATA.payload = (ds) => ({
    columns: COLUMNS, labels: DATA.LABELS,
    rows: ds.years.map((y) => ({ year: y, values: Object.fromEntries(COLUMNS.map((c) => [c, U.isNum(ds.T.get(y)[c]) ? ds.T.get(y)[c] : null])), source: { ...ds.P.get(y) } })),
    last_hist_year: ds.lastHist, has_age_detail: ds.hasAgeDetail, refresh: ds.refresh,
  });
  DATA.templateCsv = () => PS.csv.write([{ year: 2027 }, { year: 2028 }], ["year", ...COLUMNS]);
})(globalThis);
