/* Pension Simulator – population age structure and cohort-component projection.
   Port of core/population.py: same schedules, calibration, projection and back-test. */
(function (G) {
  "use strict";
  const PS = G.PS, U = PS.util, D = G.PS_DEFAULTS;
  const POP = (PS.population = {});
  const TOP = 90, MAXA = 100, NA = MAXA + 1, SEXES = ["M", "F"];
  POP.TOP = TOP; POP.MAXA = MAXA;
  const SILER = {
    M: { a1: 0.003, b1: 1.3, a2: 0.00035, b3: 0.090 },
    F: { a1: 0.0026, b1: 1.3, a2: 0.00012, b3: 0.106 },
  };

  // ------------------------------------------------------------------ inputs
  const toMap = (obj, top = TOP) => {
    const m = new Map();
    for (const y of Object.keys(obj)) {
      const src = obj[y], arr = new Float64Array(top + 1);
      for (let a = 0; a < src.length; a++) arr[Math.min(a, top)] += src[a] || 0;
      m.set(+y, arr);
    }
    return new Map([...m.entries()].sort((a, b) => a[0] - b[0]));
  };
  POP.loadKshAges = () => {
    const off = PS.data.official;
    if (off && off.ksh_ages && off.ksh_ages.M && Object.keys(off.ksh_ages.M).length)
      return { ages: { M: toMap(off.ksh_ages.M), F: toMap(off.ksh_ages.F) }, src: "KSH nep0003 (downloaded)" };
    return { ages: { M: toMap(D.kshAges.M), F: toMap(D.kshAges.F) }, src: "KSH nep0003" };
  };
  POP.loadEurostatSex = (kind, variant = "BSL") => {
    const off = PS.data.official;
    if (!off) return null;
    const src = kind === "hist" ? off.eurostat_hist : off.eurostat_proj && off.eurostat_proj[variant];
    if (!src || !src.M || !src.F) return null;
    const conv = (o) => { const m = new Map(); Object.keys(o).map(Number).sort((a, b) => a - b).forEach((y) => { const a = new Float64Array(NA); o[y].forEach((v, i) => { a[Math.min(i, MAXA)] += v || 0; }); m.set(y, a); }); return m; };
    return { M: conv(src.M), F: conv(src.F) };
  };
  const VITAL = new Map(D.vital.map((r) => [r.year, r]));
  POP.vital = VITAL;
  const lastVital = () => U.max([...VITAL.keys()]);

  // ------------------------------------------------------------------ history completion
  POP.completeHistory = (totals) => {
    const { ages: ksh, src: kshSrc } = POP.loadKshAges();
    const known = { M: new Map(ksh.M), F: new Map(ksh.F) };
    const source = new Map([...ksh.M.keys()].map((y) => [y, kshSrc]));
    const es = POP.loadEurostatSex("hist");
    if (es) {
      for (const s of SEXES) for (const [y, arr] of es[s]) {
        if (known[s].has(y) || y < 1990) continue;
        const t = new Float64Array(TOP + 1); arr.forEach((v, a) => { t[Math.min(a, TOP)] += v; });
        known[s].set(y, t);
      }
      for (const y of es.M.keys()) if (!source.has(y)) source.set(y, "Eurostat demo_pjan");
    }
    const kyears = [...known.M.keys()].sort((a, b) => a - b);
    const y0 = kyears[0], y1 = kyears[kyears.length - 1];
    const years = U.range(Math.max(1990, y0), y1 + 1);
    const full = { M: new Map(), F: new Map() };
    for (const y of years) {
      if (known.M.has(y)) { for (const s of SEXES) full[s].set(y, Float64Array.from(known[s].get(y))); continue; }
      const t0 = Math.max(...kyears.filter((k) => k < y)), t1 = Math.min(...kyears.filter((k) => k > y));
      const d0 = y - t0, d1 = t1 - y, w0 = d1 / (t1 - t0);
      for (const s of SEXES) {
        const P0 = known[s].get(t0), P1 = known[s].get(t1), row = new Float64Array(TOP + 1);
        for (let a = 0; a <= TOP; a++) {
          const same = w0 * P0[a] + (1 - w0) * P1[a];
          if (a === TOP) { row[a] = same; continue; }
          const v0 = a - d0 >= 0 ? P0[a - d0] : null, v1 = a + d1 < TOP ? P1[a + d1] : null;
          if (v0 !== null && v1 !== null) row[a] = w0 * v0 + (1 - w0) * v1;
          else if (v1 !== null) row[a] = v1;
          else row[a] = same;
        }
        full[s].set(y, row);
      }
      source.set(y, `cohort-interpolated ${t0}–${t1}`);
    }
    for (const y of years) {
      if (source.get(y).startsWith("KSH")) continue;
      const tot = totals.get(y);
      const cur = U.sum(full.M.get(y)) + U.sum(full.F.get(y));
      if (U.isNum(tot) && cur > 0) { const f = tot / cur; for (const s of SEXES) full[s].set(y, full[s].get(y).map((v) => v * f)); }
    }
    return { ages: full, source, years };
  };

  // ------------------------------------------------------------------ schedules
  const sexpr = new Float64Array(NA);
  POP.silerMx = (sex, level) => {
    const p = SILER[sex], m = new Float64Array(NA);
    for (let a = 0; a < NA; a++) {
      const x = a === 0 ? 0.1 : a + 0.5;
      m[a] = Math.min(p.a1 * Math.exp(-p.b1 * x) + p.a2 + level * 1e-5 * Math.exp(p.b3 * x), 1.5);
    }
    return m;
  };
  POP.lifeTable = (mx) => {
    const n = mx.length, lx = new Float64Array(n), Lx = new Float64Array(n), qx = new Float64Array(n), Tx = new Float64Array(n);
    for (let i = 0; i < n; i++) { const ax = i === 0 ? 0.15 : 0.5; qx[i] = mx[i] / (1 + (1 - ax) * mx[i]); }
    qx[n - 1] = 1;
    lx[0] = 1; for (let i = 1; i < n; i++) lx[i] = lx[i - 1] * (1 - qx[i - 1]);
    for (let i = 0; i < n - 1; i++) { const ax = i === 0 ? 0.15 : 0.5; Lx[i] = lx[i + 1] + ax * lx[i] * qx[i]; }
    Lx[n - 1] = lx[n - 1] / mx[n - 1];
    let acc = 0; for (let i = n - 1; i >= 0; i--) { acc += Lx[i]; Tx[i] = acc; }
    return { lx, Lx, Tx, e0: Tx[0] };
  };
  const CAL = new Map();
  POP.survival = (sex, e0) => {
    const k100 = U.roundHalfEven(e0 * 100), key = sex + k100;
    if (CAL.has(key)) return CAL.get(key);
    const target = k100 / 100;
    let lo = Math.log(0.01), hi = Math.log(200);
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (POP.lifeTable(POP.silerMx(sex, Math.exp(mid))).e0 > target) lo = mid; else hi = mid;
    }
    const lt = POP.lifeTable(POP.silerMx(sex, Math.exp((lo + hi) / 2)));
    const S = new Float64Array(NA);
    for (let a = 0; a < NA - 2; a++) S[a] = lt.Lx[a + 1] / lt.Lx[a];
    S[NA - 2] = lt.Tx[NA - 1] / lt.Tx[NA - 2];
    S[NA - 1] = lt.Tx[NA - 1] / lt.Tx[NA - 2];
    const out = { S, L0: lt.Lx[0], Lx: lt.Lx };
    if (CAL.size > 5000) CAL.clear();
    CAL.set(key, out);
    return out;
  };
  POP.fertility = (tfr, meanAge, sd = 5.4) => {
    const shift = 12, mu = meanAge - shift, theta = (sd * sd) / mu, k = mu / theta, f = new Float64Array(NA);
    for (let a = 15; a < 50; a++) { const x = a + 0.5 - shift; f[a] = x > 0 ? Math.pow(Math.max(x, 1e-9), k - 1) * Math.exp(-x / theta) : 0; }
    const s = U.sum(f); for (let a = 0; a < NA; a++) f[a] = (f[a] / s) * tfr;
    return f;
  };
  const MIG = (() => {
    const g = new Float64Array(NA);
    for (let x = 0; x < NA; x++) g[x] = 0.02 * Math.exp(-0.12 * x) + Math.exp(-0.5 * ((x - 27) / 7.5) ** 2) * 0.09 + 0.004 * Math.exp(-0.5 * ((x - 62) / 6) ** 2);
    const s = U.sum(g); return g.map((v) => v / s);
  })();
  POP.splitOpenGroup = (p90, sex, e0) => {
    const w = POP.survival(sex, e0).Lx.slice(TOP), s = U.sum(w);
    return w.map((v) => (p90 * v) / s);
  };
  const extendBase = (row91, sex, e0) => { const out = new Float64Array(NA); out.set(row91.subarray(0, TOP)); out.set(POP.splitOpenGroup(row91[TOP], sex, e0), TOP); return out; };

  // ------------------------------------------------------------------ projection
  POP.project = (base, start, end, tfrP, e0mP, e0fP, migP, meanAge, srb) => {
    const shareM = srb / (1 + srb);
    const pops = new Map([[start, { M: Float64Array.from(base.M), F: Float64Array.from(base.F) }]]);
    const flows = new Map();
    for (let y = start; y < end; y++) {
      const P = pops.get(y);
      const sm = POP.survival("M", e0mP(y)), sf = POP.survival("F", e0fP(y));
      const S = { M: sm.S, F: sf.S };
      const W = P.F, f = POP.fertility(tfrP(y), meanAge);
      let births = 0;
      for (let a = 0; a < NA; a++) { const wn = a === 0 ? 0 : W[a - 1] * sf.S[a - 1]; births += f[a] * 0.5 * (W[a] + wn); }
      const nm = migP(y), nxt = {};
      let deaths = 0;
      for (const [s, L0] of [["M", sm.L0], ["F", sf.L0]]) {
        const p = P[s], n = new Float64Array(NA);
        for (let a = 1; a < MAXA; a++) n[a] = p[a - 1] * S[s][a - 1];
        n[MAXA] = (p[MAXA - 1] + p[MAXA]) * S[s][MAXA];
        const b = births * (s === "M" ? shareM : 1 - shareM);
        n[0] = b * L0;
        deaths += U.sum(p) + b - U.sum(n);
        for (let a = 0; a < NA; a++) n[a] = Math.max(n[a] + 0.5 * nm * MIG[a], 0);
        nxt[s] = n;
      }
      pops.set(y + 1, nxt);
      flows.set(y, { births, deaths, net_migration: nm, tfr: tfrP(y), e0_m: e0mP(y), e0_f: e0fP(y) });
    }
    return { pops, flows };
  };
  const linearPath = (y0, v0, y1, v1) => (y) => (y <= y0 ? v0 : y >= y1 ? v1 : v0 + ((v1 - v0) * (y - y0)) / (y1 - y0));

  // ------------------------------------------------------------------ indicators
  const segSum = (arr, a0, a1) => { let s = 0; const e = a1 === undefined ? arr.length : Math.min(a1, arr.length); for (let a = a0; a < e; a++) s += arr[a]; return s; };
  POP.indicators = (M, F) => {
    const n = M.length, T = new Float64Array(n);
    for (let a = 0; a < n; a++) T[a] = M[a] + F[a];
    const tot = U.sum(T), g014 = segSum(T, 0, 15), g1564 = segSum(T, 15, 65), g65 = segSum(T, 65), g80 = segSum(T, 80);
    let cum = 0, i = 0;
    const cums = new Float64Array(n); for (let a = 0; a < n; a++) { cum += T[a]; cums[a] = cum; }
    while (i < n && cums[i] < tot / 2) i++;
    const prev = i > 0 ? cums[i - 1] : 0;
    const median = i + (tot / 2 - prev) / Math.max(T[i], 1);
    const sx = {};
    for (const [lab, a0, a1] of [["0_14", 0, 15], ["15_64", 15, 65], ["65_plus", 65, undefined], ["80_plus", 80, undefined]]) {
      sx[`age_${lab}_m`] = segSum(M, a0, a1); sx[`age_${lab}_f`] = segSum(F, a0, a1);
    }
    const sm = U.sum(M), sf = U.sum(F);
    return {
      ...sx, women_per_1000_men: (sf / sm) * 1000, share_women: (sf / tot) * 100,
      total: tot, male: sm, female: sf, age_0_14: g014, age_15_64: g1564, age_65_plus: g65, age_80_plus: g80,
      share_0_14: (g014 / tot) * 100, share_15_64: (g1564 / tot) * 100, share_65_plus: (g65 / tot) * 100, share_80_plus: (g80 / tot) * 100,
      old_age_dependency: (g65 / g1564) * 100, median_age: median, open_age: n - 1,
    };
  };
  POP.popAtOrAbove = PS.data.popAtOrAbove;
  const toTop = (v) => { const out = []; for (let a = 0; a < TOP; a++) out.push(U.roundHalfEven(v[a])); out.push(U.roundHalfEven(segSum(v, TOP))); return out; };
  POP.toTop = toTop;

  // ------------------------------------------------------------------ main entry
  POP.run = (ds, s, variant = "BSL", variants = true) => {
    const totals = new Map(ds.years.map((y) => [y, ds.T.get(y).population]));
    const hist = POP.completeHistory(totals);
    const H = hist.ages, yearsH = hist.years, baseYear = yearsH[yearsH.length - 1];
    const lv = lastVital(), vr = VITAL.get(lv);
    const e0m0 = vr.e0_m, e0f0 = vr.e0_f, tfr0 = vr.tfr;
    const base = { M: extendBase(H.M.get(baseYear), "M", e0m0), F: extendBase(H.F.get(baseYear), "F", e0f0) };
    const end = s.end_year, gain = s.le_gain_decade / 10, extraM = s.male_extra_gain / 10;
    const variantRun = (dTfr = 0, dMig = 0, dGain = 0) => POP.project(base, baseYear, end + 1,
      linearPath(lv, tfr0, s.tfr_target_year, s.tfr_target + dTfr),
      (y) => e0m0 + (gain + extraM + dGain / 10) * (y - lv),
      (y) => e0f0 + (gain + dGain / 10) * (y - lv),
      () => s.net_migration + dMig, s.mean_age_birth, s.srb);
    const central = variantRun();
    const low = variants ? variantRun(-0.2, -10000, -0.5) : central;
    const high = variants ? variantRun(0.2, 10000, 0.5) : central;

    const rows = [];
    for (const y of yearsH) {
      const ind = POP.indicators(H.M.get(y), H.F.get(y)), v = VITAL.get(y);
      rows.push({ year: y, type: "observed", age_source: hist.source.get(y), ...ind,
        births: v ? v.births : null, deaths: v ? v.deaths : null, tfr: v ? v.tfr : null, e0_m: v ? v.e0_m : null, e0_f: v ? v.e0_f : null });
    }
    for (let i = 0; i < rows.length - 1; i++) {
      const r = rows[i], n = rows[i + 1];
      if (r.births !== null && r.year >= 2001 && n.year === r.year + 1) r.net_migration = n.total - r.total - (r.births - r.deaths);
    }
    for (let y = baseYear + 1; y <= end; y++) {
      const P = central.pops.get(y), ind = POP.indicators(P.M, P.F), fl = central.flows.get(y) || {};
      const lo = low.pops.get(y), hi = high.pops.get(y);
      rows.push({ year: y, type: "projection", age_source: "cohort-component projection", ...ind,
        total_low: U.sum(lo.M) + U.sum(lo.F), total_high: U.sum(hi.M) + U.sum(hi.F),
        births: fl.births ?? null, deaths: fl.deaths ?? null, net_migration: fl.net_migration ?? null,
        tfr: fl.tfr ?? null, e0_m: fl.e0_m ?? null, e0_f: fl.e0_f ?? null });
    }
    const fb = central.flows.get(baseYear);
    for (const r of rows) {
      if (r.year === baseYear && fb && r.births === null) Object.assign(r, { births: fb.births, deaths: fb.deaths, tfr: fb.tfr, e0_m: fb.e0_m, e0_f: fb.e0_f });
      if (r.year === baseYear && fb) r.net_migration = fb.net_migration;
    }
    const comp = {}, esProj = POP.loadEurostatSex("proj", variant);
    if (esProj) for (const y of esProj.M.keys()) if (y >= baseYear) comp[y] = U.sum(esProj.M.get(y)) + U.sum(esProj.F.get(y));
    const fallbackTotals = {};
    for (const y of ds.years) if (y > baseYear && y <= end && U.isNum(ds.T.get(y).population)) fallbackTotals[y] = ds.T.get(y).population;

    const pyramids = {};
    for (const y of yearsH) pyramids[y] = { M: toTop(H.M.get(y)), F: toTop(H.F.get(y)), type: "observed", source: hist.source.get(y) };
    for (let y = baseYear + 1; y <= end; y++) { const P = central.pops.get(y); pyramids[y] = { M: toTop(P.M), F: toTop(P.F), type: "projection", source: "cohort-component projection" }; }
    const esPyr = {};
    if (esProj) for (const y of esProj.M.keys()) if (y > baseYear && y <= end) esPyr[y] = { M: toTop(esProj.M.get(y)), F: toTop(esProj.F.get(y)) };

    const agesTotal = new Map(), agesSex = new Map();
    for (const y of yearsH) { const m = H.M.get(y), f = H.F.get(y); agesTotal.set(y, m.map((v, a) => v + f[a])); agesSex.set(y, { M: m, F: f }); }
    for (let y = baseYear + 1; y <= end; y++) { const P = central.pops.get(y); agesTotal.set(y, P.M.map((v, a) => v + P.F[a])); agesSex.set(y, { M: P.M, F: P.F }); }

    return {
      base_year: baseYear, rows, pyramids, eurostat_pyramids: esPyr, eurostat_totals: comp, fallback_totals: fallbackTotals,
      ages_total: agesTotal, ages_sex: agesSex,
      assumptions: { tfr_start: tfr0, tfr_target: s.tfr_target, tfr_target_year: s.tfr_target_year, e0_m_start: e0m0, e0_f_start: e0f0,
        net_migration: s.net_migration, mean_age_birth: s.mean_age_birth, srb: s.srb,
        variants: "low/high: TFR ±0.2, net migration ±10,000 a year, life-expectancy gain ±0.5 years a decade" },
      validation: POP.backtest(),
      age_sources: Object.fromEntries(hist.source),
    };
  };

  let BT = null;
  POP.backtest = () => {
    if (BT) return BT;
    const { ages: ksh } = POP.loadKshAges();
    if (!ksh.M.has(2016) || !ksh.M.has(2026)) return (BT = {});
    const pops = { 2016: 9779652, 2017: 9739857, 2018: 9713655, 2019: 9700272, 2020: 9689376, 2021: 9651461, 2022: 9610403, 2023: 9599744, 2024: 9584627, 2025: 9539502, 2026: 9488428 };
    const V = (y, k) => VITAL.get(y)[k];
    const mig = {}; for (let y = 2016; y < 2026; y++) mig[y] = pops[y + 1] - pops[y] - (V(y, "births") - V(y, "deaths"));
    const base = { M: extendBase(ksh.M.get(2016), "M", V(2016, "e0_m")), F: extendBase(ksh.F.get(2016), "F", V(2016, "e0_f")) };
    const res = POP.project(base, 2016, 2026, (y) => V(y, "tfr"), (y) => V(y, "e0_m"), (y) => V(y, "e0_f"), (y) => mig[y], 30.6, 1.05);
    const P = res.pops.get(2026), obs = { M: ksh.M.get(2026), F: ksh.F.get(2026) };
    const pm = Float64Array.from(toTop(P.M)), pf = Float64Array.from(toTop(P.F));
    const ip = POP.indicators(pm, pf), io = POP.indicators(obs.M, obs.F);
    const err = (a, b) => ((a - b) / b) * 100;
    const ageErr = U.range(0, TOP + 1).map((a) => U.roundHalfEven((Math.abs(pm[a] + pf[a] - (obs.M[a] + obs.F[a])) / (obs.M[a] + obs.F[a])) * 100, 2));
    const ageErrRaw = U.range(0, TOP + 1).map((a) => (Math.abs(pm[a] + pf[a] - (obs.M[a] + obs.F[a])) / (obs.M[a] + obs.F[a])) * 100);
    let bp = 0, bo = 0, dp = 0, dO = 0;
    for (let y = 2016; y < 2026; y++) { bp += res.flows.get(y).births; bo += V(y, "births"); dp += res.flows.get(y).deaths; dO += V(y, "deaths"); }
    const row = (indicator, a, b) => ({ indicator, projected: a, observed: b, error_pct: err(a, b) });
    BT = {
      period: "1 Jan 2016 → 1 Jan 2026",
      rows: [row("Total population", ip.total, io.total), row("Aged 0–14", ip.age_0_14, io.age_0_14), row("Aged 15–64", ip.age_15_64, io.age_15_64),
        row("Aged 65+", ip.age_65_plus, io.age_65_plus), row("Aged 80+", ip.age_80_plus, io.age_80_plus),
        row("Births 2016–2025", bp, bo), row("Deaths 2016–2025", dp, dO)],
      age_mape: U.mean(ageErrRaw), age_error_by_age: ageErr,
    };
    return BT;
  };
  POP.resetCache = () => { BT = null; };
})(globalThis);
