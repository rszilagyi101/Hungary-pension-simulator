/* Pension Simulator – scenario builder (port of core/scenarios.py).
   Each parameter is a named change applied on top of the baseline (sidebar) settings, grouped by its
   expected effect on the pension burden (recipients per 100 people aged 15–64). */
(function (G) {
  "use strict";
  const PS = G.PS, U = PS.util, SET = PS.settings, D = G.PS_DEFAULTS;
  const SC = (PS.scenarios = {});
  const add = (key, sign = 1) => (s, v) => { s[key] = s[key] + sign * v; };
  const APPLY = {
    ret_age_up: (s, v) => { s.ret_age_target = s.ret_age_target + v; },
    ret_age_fast: (s, v) => { s.ret_age_start -= v; s.ret_age_end -= v; },
    ret_age_le: (s, v) => { s.link_ret_age_le = true; s.le_link_share = v; },
    fertility_up: add("tfr_target"),
    immigration_up: add("net_migration"),
    disability_tight: add("ratio_drift_pct", -1),
    longevity_fast: add("le_gain_decade"),
    emigration: add("net_migration", -1),
    fertility_down: add("tfr_target", -1),
    early_exit: add("ratio_drift_pct"),
    elderly_up: add("elderly_pop_adj_pct"),
    ret_age_slow: (s, v) => { s.ret_age_start += v; s.ret_age_end += v; },
    gender_gap: add("male_extra_gain"),
    later_births: add("mean_age_birth"),
    fert_delay: add("tfr_target_year"),
    srb: add("srb"),
    eurostat_pop: (s) => { s.population_source = "eurostat"; },
  };
  SC.PARAMS = D.scenarioParams;
  SC.BY_KEY = Object.fromEntries(SC.PARAMS.map((p) => [p.key, p]));
  SC.CATEGORY_LABELS = D.categoryLabels;

  SC.apply = (base, selection) => {
    const s = { ...base };
    for (const [key, val] of Object.entries(selection)) {
      const p = SC.BY_KEY[key];
      if (!p || !APPLY[key]) continue;
      const v = U.clip(Number(val === null || val === undefined ? p.default : val), p.min, p.max);
      APPLY[key](s, v);
    }
    const out = SET.validate(s);
    const changes = SET.SPEC.filter((sp) => out[sp.key] !== base[sp.key]).map((sp) => ({ key: sp.key, label: sp.label, baseline: base[sp.key], scenario: out[sp.key] }));
    return { s: out, changes };
  };

  const summary = (res) => {
    const popRows = new Map(res.population.rows.map((r) => [r.year, r]));
    const years = [...res.hist_years, ...res.future_years];
    const pens = [...res.hist_values, ...res.ensemble.pred];
    const lo = [...res.hist_years.map(() => null), ...res.ensemble.lo], hi = [...res.hist_years.map(() => null), ...res.ensemble.hi];
    const bs = res.by_sex || {}; let men = new Map(), women = new Map();
    if (bs.available) {
      men = new Map([...bs.hist_years.map((y, i) => [y, bs.men[i]]), ...bs.future_years.map((y, i) => [y, bs.men_pred[i]])]);
      women = new Map([...bs.hist_years.map((y, i) => [y, bs.women[i]]), ...bs.future_years.map((y, i) => [y, bs.women_pred[i]])]);
    }
    const ra = new Map([...res.hist_exog, ...res.future_exog].map((e) => [e.year, e.retirement_age]));
    const ser = { years, pensioners: pens, lower: lo, upper: hi, men: years.map((y) => men.get(y) ?? null), women: years.map((y) => women.get(y) ?? null),
      population: [], age_15_64: [], age_65_plus: [], share_65_plus: [], dependency: [], retirement_age: [] };
    years.forEach((y, i) => {
      const r = popRows.get(y);
      ser.population.push(r ? r.total : null); ser.age_15_64.push(r ? r.age_15_64 : null); ser.age_65_plus.push(r ? r.age_65_plus : null);
      ser.share_65_plus.push(r ? r.share_65_plus : null); ser.dependency.push(r ? (pens[i] / r.age_15_64) * 100 : null);
      ser.retirement_age.push(ra.get(y) ?? null);
    });
    return { series: ser, last_hist_year: res.last_actual.year, target_label: res.target_label, warnings: res.warnings };
  };
  const at = (sm, year, metric) => { const i = sm.series.years.indexOf(year); return i >= 0 ? sm.series[metric][i] : null; };

  // runs sequentially, yielding to the page between simulations; onProgress(done, total)
  SC.run = async (ds, base, selection, { name = "Custom scenario", presets = true, impacts = true, impactMode = "within", onProgress } = {}) => {
    base = SET.validate(base);
    const jobs = [["baseline", "Baseline (sidebar settings)", {}], ["custom", name || "Custom scenario", selection]];
    if (presets) {
      jobs.push(["optimistic", "Optimistic: all positive parameters", Object.fromEntries(SC.PARAMS.filter((p) => p.category === "positive").map((p) => [p.key, p.default]))]);
      jobs.push(["pessimistic", "Pessimistic: all negative parameters", Object.fromEntries(SC.PARAMS.filter((p) => p.category === "negative").map((p) => [p.key, p.default]))]);
    }
    const selKeys = Object.keys(selection).filter((k) => SC.BY_KEY[k]);
    let mode = impactMode, impactJobs = [];
    if (mode === "within") {
      if (impacts && selKeys.length > 1) impactJobs = selKeys.map((k) => [`impact:${k}`, SC.BY_KEY[k].label, Object.fromEntries(selKeys.filter((j) => j !== k).map((j) => [j, selection[j]]))]);
      if (impacts && selKeys.length === 1) mode = "alone";
    }
    if (mode === "alone") impactJobs = impacts ? selKeys.map((k) => [`impact:${k}`, SC.BY_KEY[k].label, { [k]: selection[k] }]) : [];
    const all = [...jobs, ...impactJobs], done = [];
    for (let i = 0; i < all.length; i++) {
      const [jid, label, sel] = all[i];
      const { s, changes } = SC.apply(base, sel);
      const res = PS.models.run(ds, s, false);
      done.push({ jid, label, sel, s, changes, res });
      if (onProgress) onProgress(i + 1, all.length);
      await new Promise((r) => setTimeout(r, 0));
    }
    const horizon = base.end_year;
    const mile = [2030, 2040, 2050, 2060, 2070].filter((y) => y <= horizon);
    if (!mile.includes(horizon)) mile.push(horizon);
    const scen = [], imp = [];
    let baseSum = null, custSum = null;
    for (const d of done) {
      const sm = summary(d.res);
      if (d.jid === "custom") custSum = sm;
      if (d.jid === "baseline") baseSum = sm;
      if (d.jid.startsWith("impact:")) { imp.push({ key: d.jid.split(":")[1], sel: d.sel, sm }); continue; }
      scen.push({ id: d.jid, name: d.label, selection: d.sel, changes: d.changes, settings: d.s, ...sm,
        full: d.jid === "baseline" || d.jid === "custom" ? d.res : null });
    }
    const iy = 2050 <= horizon ? 2050 : horizon;
    for (const sc of scen) {
      sc.milestones = mile.map((y) => {
        const row = { year: y };
        for (const m of ["pensioners", "men", "women", "population", "dependency", "share_65_plus", "retirement_age"]) {
          const v = at(sc, y, m), b = at(baseSum, y, m);
          row[m] = v; row[`${m}_diff`] = v === null || b === null ? null : v - b;
        }
        return row;
      });
    }
    const impactsOut = imp.map(({ key, sm }) => {
      const p = SC.BY_KEY[key];
      const [hiS, loS] = mode === "within" ? [custSum, sm] : [sm, baseSum];
      const dDep = at(hiS, iy, "dependency") - at(loS, iy, "dependency");
      const dPen = at(hiS, iy, "pensioners") - at(loS, iy, "pensioners");
      const dPop = at(hiS, iy, "population") - at(loS, iy, "population");
      const fy = hiS.series.years.filter((y) => y > hiS.last_hist_year);
      const dAvg = U.mean(fy.map((y) => at(hiS, y, "dependency") - at(loS, y, "dependency")));
      const dPenAvg = U.mean(fy.map((y) => at(hiS, y, "pensioners") - at(loS, y, "pensioners")));
      const dominant = Math.abs(dDep) >= Math.abs(dAvg) ? dDep : dAvg;
      const observed = Math.abs(dominant) < 0.25 ? "neutral" : dominant < 0 ? "positive" : "negative";
      const noEff = Math.abs(dPen) < 1 && Math.abs(dPop) < 1 && Math.abs(dPenAvg) < 1;
      let status;
      if (noEff) status = "no effect in this combination";
      else if (observed === p.category) status = "as expected";
      else if (observed === "neutral") status = (dominant < 0) === (p.category === "positive") || p.category === "neutral" ? "weaker than the threshold" : "opposite direction";
      else status = p.category !== "neutral" ? "opposite direction" : "stronger than neutral";
      return { key, label: p.label, category: p.category, value: selection[key], unit: p.unit, year: iy,
        d_dependency: dDep, d_pensioners: dPen, d_population: dPop, d_dependency_avg: dAvg, d_pensioners_avg: dPenAvg,
        observed, status, as_expected: observed === p.category, no_effect: noEff };
    });
    const dom = (r) => (Math.abs(r.d_dependency) >= Math.abs(r.d_dependency_avg) ? r.d_dependency : r.d_dependency_avg);
    impactsOut.sort((a, b) => dom(a) - dom(b));
    const order = { baseline: 0, custom: 1, optimistic: 2, pessimistic: 3 };
    scen.sort((a, b) => (order[a.id] ?? 9) - (order[b.id] ?? 9));
    return { scenarios: scen, impacts: impactsOut, impact_year: iy, milestone_years: mile, impact_mode: mode,
      base_settings: base, selection, name,
      metric_note: "Pension burden = recipients per 100 people aged 15–64. The measured direction uses the larger of the change in the impact year and the average change over the forecast years; below 0.25 points it counts as neutral." };
  };

  // ------------------------------------------------------------------ saved scenarios (this browser)
  const KEY = "pensim.scenarios.v1";
  let mem = [];
  SC.loadSaved = () => { try { const t = G.localStorage && G.localStorage.getItem(KEY); if (t) return JSON.parse(t); } catch (e) { /* blocked */ } return mem.slice(); };
  const store = (items) => { mem = items; try { G.localStorage && G.localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) { /* memory only */ } return items; };
  SC.save = (name, selection) => store([...SC.loadSaved().filter((x) => x.name !== name), { name, selection: Object.fromEntries(Object.entries(selection).filter(([k]) => SC.BY_KEY[k])) }]);
  SC.remove = (name) => store(SC.loadSaved().filter((x) => x.name !== name));
})(globalThis);
