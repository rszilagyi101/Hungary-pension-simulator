/* Hungarian Pension Simulator – page logic (web version).
   All requests go to PS.api, which runs the simulation in this browser. */
const state = { spec: [], defaults: {}, settings: {}, runId: null, result: null, data: null, edits: new Map(), chart: null, timer: null, busy: false };

const MODEL_COLORS = { arima: "#3d6fa5", ets: "#8a5a9e", structural: "#c07f1d", rf: "#4f8f8a", gb: "#6b7f2b", ridge: "#7a6a58", mlp: "#b0558a" };
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const fmt = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v)) ? "" : Number(v).toLocaleString("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d });
const millions = v => (v / 1e6).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function setStatus(msg, err = false) { const el = $("#status"); el.textContent = msg; el.classList.toggle("err", err); }

const paint = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));  // let the page draw before heavy work
async function api(url, opts = {}) {
  return PS.api.call(url, opts);
}

/* ------------------------------------------------------------------ tabs */
$$(".tab").forEach(t => t.addEventListener("click", () => {
  $$(".tab").forEach(x => { x.classList.toggle("active", x === t); x.setAttribute("aria-selected", x === t); });
  $$(".panel").forEach(p => p.classList.toggle("active", p.id === `tab-${t.dataset.tab}`));
  requestAnimationFrame(() => Object.values(state.popCharts || {}).concat(state.chart ? [state.chart] : [], Object.values(tree.minis)).forEach(c => c && c.resize()));
}));

/* ------------------------------------------------------------------ controls */
const DEPENDS = {
  arima_p: "use_arima", arima_d: "use_arima", arima_q: "use_arima", arima_exog: "use_arima", arima_log: "use_arima",
  ets_damped: "use_ets", ets_phi: "use_ets", ets_log: "use_ets",
  ratio_window: "use_structural", ratio_phi: "use_structural",
  rf_trees: "use_rf", rf_depth: "use_rf", gb_trees: "use_gb", gb_lr: "use_gb", gb_depth: "use_gb",
  ridge_alpha: "use_ridge", mlp_hidden: "use_mlp", mlp_alpha: "use_mlp", le_link_share: "link_ret_age_le",
};

function renderControls() {
  const host = $("#controlGroups");
  host.innerHTML = "";
  const groups = [...new Set(state.spec.map(s => s.group))];
  groups.forEach((g, gi) => {
    const det = document.createElement("details");
    det.className = "group";
    if (gi < 2) det.open = true;
    det.innerHTML = `<summary>${g}</summary><div class="group-body"></div>`;
    const body = $(".group-body", det);
    state.spec.filter(s => s.group === g).forEach(s => body.appendChild(controlFor(s)));
    host.appendChild(det);
  });
  syncDependencies();
}

function controlFor(s) {
  const wrap = document.createElement("div");
  wrap.className = `ctl ${s.type}`;
  wrap.dataset.key = s.key;
  const id = `c_${s.key}`;
  const val = state.settings[s.key];
  if (s.type === "bool") {
    wrap.innerHTML = `<label><input type="checkbox" id="${id}" ${val ? "checked" : ""}> <span>${s.label}</span></label>`;
    $("input", wrap).addEventListener("change", e => update(s.key, e.target.checked));
  } else if (s.type === "select") {
    wrap.innerHTML = `<label class="lbl" for="${id}">${s.label}</label><select id="${id}">${s.options.map(([v, l]) => `<option value="${v}" ${String(val) === v ? "selected" : ""}>${l}</option>`).join("")}</select>`;
    $("select", wrap).addEventListener("change", e => update(s.key, e.target.value));
  } else {
    wrap.innerHTML = `<label class="lbl" for="${id}">${s.label}</label>
      <div class="pair"><input type="range" min="${s.min}" max="${s.max}" step="${s.step}" value="${val}" aria-label="${s.label}">
      <input type="number" id="${id}" min="${s.min}" max="${s.max}" step="${s.step}" value="${val}"></div>`;
    const [range, num] = $$("input", wrap);
    range.addEventListener("input", () => { num.value = range.value; update(s.key, Number(range.value)); });
    num.addEventListener("change", () => {
      let v = Math.min(Math.max(Number(num.value), s.min), s.max);
      if (s.type === "int") v = Math.round(v);
      num.value = v; range.value = v; update(s.key, v);
    });
  }
  return wrap;
}

function setControlValue(key, v) {
  const w = $(`.ctl[data-key="${key}"]`);
  if (!w) return;
  const inputs = $$("input,select", w);
  inputs.forEach(i => { if (i.type === "checkbox") i.checked = !!v; else i.value = v; });
}

function syncDependencies() {
  Object.entries(DEPENDS).forEach(([k, dep]) => {
    const w = $(`.ctl[data-key="${k}"]`);
    if (w) w.classList.toggle("disabled", !state.settings[dep]);
  });
  const manual = state.settings.ensemble_mode === "manual";
  $$('.ctl[data-key^="w_"]').forEach(w => w.classList.toggle("disabled", !manual));
}

function update(key, value) {
  state.settings[key] = value;
  syncDependencies();
  if (key === "projection_variant") {
    api(`/api/data?variant=${value}`).then(d => { state.data = d; renderData(); });
  }
  if ($("#autoRun").checked) {
    clearTimeout(state.timer);
    state.timer = setTimeout(runSimulation, 650);
  }
}

function applySettings(s) {
  state.settings = { ...state.defaults, ...s };
  Object.entries(state.settings).forEach(([k, v]) => setControlValue(k, v));
  syncDependencies();
}

/* ------------------------------------------------------------------ simulation */
async function runSimulation() {
  if (state.busy) { clearTimeout(state.timer); state.timer = setTimeout(runSimulation, 400); return; }
  state.busy = true;
  $("#runBtn").disabled = true;
  setStatus("Fitting models and back-testing…");
  await paint();
  try {
    const res = await api("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.settings) });
    state.runId = res.run_id;
    state.result = res.result;
    applySettings(res.settings); // server may have clamped values
    renderResult();
    const r = res.result;
    setStatus(`${r.target_label}: observed ${r.hist_years[0]}–${r.last_actual.year}, forecast to ${r.future_years.at(-1)}. ${Object.keys(r.weights).length} models, ${r.runtime_s} s.`);
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    state.busy = false;
    $("#runBtn").disabled = false;
    $$(".exp[data-fmt]").forEach(a => a.classList.toggle("off", !state.runId));
  }
}

function renderResult() {
  const r = state.result;
  $("#chartTitle").textContent = `${r.target_label}, observed and simulated`;
  renderChart(r);
  renderMilestones(r);
  renderMetrics(r);
  renderYearTable(r);
  $("#denomNote").textContent = `Ratio models use the ${r.denominator}. Hold-out years: ${r.ensemble_backtest.years[0]}–${r.ensemble_backtest.years.at(-1)}.`;
  $("#warnings").innerHTML = r.warnings.length ? `<ul>${r.warnings.map(w => `<li>${w}</li>`).join("")}</ul>` : "";
  renderSex(r);
  renderPopulation(r.population);
}

/* ------------------------------------------------------------------ pensioners by sex */
function renderSex(r) {
  const bs = r.by_sex;
  $("#sexCard").hidden = !(bs && bs.available);
  if (!bs || !bs.available) return;
  state.popCharts = state.popCharts || {};
  const years = [...bs.hist_years, ...bs.future_years];
  const nH = bs.hist_years.length;
  const H = arr => [...arr, ...Array(bs.future_years.length).fill(null)];
  const F = (arr, last) => { const a = [...Array(nH).fill(null), ...arr]; a[nH - 1] = last; return a; };
  const ds = [];
  [["men", "Men", "#3d6fa5", "rgba(61,111,165,.13)"], ["women", "Women", "#b0558a", "rgba(176,85,138,.13)"]].forEach(([k, lab, col, band]) => {
    const last = bs[k].at(-1);
    ds.push({ label: `${lab} low`, data: F(bs[`${k}_lo`], last), borderWidth: 0, pointRadius: 0, fill: false, _hide: true });
    ds.push({ label: `${lab} interval`, data: F(bs[`${k}_hi`], last), borderWidth: 0, pointRadius: 0, fill: "-1", backgroundColor: band, _hide: true });
    ds.push({ label: `${lab}, observed`, data: H(bs[k]), borderColor: col, backgroundColor: col, borderWidth: 2.6, pointRadius: 0 });
    ds.push({ label: `${lab}, forecast`, data: F(bs[`${k}_pred`], last), borderColor: col, backgroundColor: col, borderWidth: 2.6, borderDash: [6, 4], pointRadius: 0 });
  });
  mkChart("sex", $("#sexChart"), {
    type: "line", data: { labels: years, datasets: ds },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
      scales: { y: { ticks: { callback: v => `${millions(v)} M` }, grid: { color: "#e6eaee" } }, x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 14 } } },
      plugins: { legend: { position: "bottom", labels: { boxWidth: 14, boxHeight: 2, filter: i => !ds[i.datasetIndex]._hide } },
        tooltip: { filter: i => i.raw !== null && !ds[i.datasetIndex]._hide, callbacks: { label: c => `${c.dataset.label}: ${fmt(c.raw)}` } } },
    },
  });
  mkChart("share", $("#shareChart"), {
    type: "line",
    data: { labels: years, datasets: [
      { label: "Women's share, observed", data: H(bs.share_women_hist), borderColor: "#b0558a", borderWidth: 2.2, pointRadius: 0 },
      { label: "forecast", data: F(bs.share_women_fut, bs.share_women_hist.at(-1)), borderColor: "#b0558a", borderDash: [6, 4], borderWidth: 2.2, pointRadius: 0 },
      { label: "back-test", data: years.map(y => { const i = bs.backtest.years.indexOf(y); return i >= 0 ? bs.backtest.share_women_pred[i] : null; }), borderColor: "#1f2e3b", borderDash: [2, 3], borderWidth: 1.2, pointRadius: 2 },
    ] },
    options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
      plugins: { title: { display: true, text: "Women's share of recipients", align: "start", font: { size: 13 } }, legend: { display: false },
        tooltip: { filter: i => i.raw !== null, callbacks: { label: c => `${c.dataset.label}: ${c.raw.toFixed(1)} %` } } },
      scales: { y: { ticks: { callback: v => `${v} %` } }, x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 18 } } } },
  });
  const rows = [[`${bs.hist_years.at(-1)} observed`, bs.men.at(-1), bs.women.at(-1)],
    ...r.milestones.filter(m => m.men != null).map(m => [m.year, m.men, m.women])];
  $("#sexMsTable").innerHTML = `<thead><tr><th>Year</th><th>Men</th><th>Women</th><th>Women %</th></tr></thead><tbody>` +
    rows.map(([y, m, w]) => `<tr><td>${y}</td><td>${fmt(m)}</td><td>${fmt(w)}</td><td>${(w / (m + w) * 100).toFixed(1)}</td></tr>`).join("") + "</tbody>";
  const b = bs.backtest;
  $("#sexNote").textContent = `Recipients per person at or above each sex's retirement age, trended separately for men and women and scaled so that men + women equal the ensemble. Back-test ${b.years[0]}–${b.years.at(-1)}: women's share off by ${b.share_mae_pp.toFixed(2)} percentage points on average (men ${b.mape_men.toFixed(2)} %, women ${b.mape_women.toFixed(2)} %).`;
}

/* ------------------------------------------------------------------ population by sex */
function renderPopSex() {
  const pop = state.pop; if (!pop) return;
  const v = $('input[name="psView"]:checked').value;
  const rows = pop.rows, years = rows.map(r => r.year);
  const key = { all: ["male", "female"], 65: ["age_65_plus_m", "age_65_plus_f"], 80: ["age_80_plus_m", "age_80_plus_f"] }[v];
  const baseIdx = years.indexOf(pop.base_year);
  const line = { id: "bl2", afterDraw(c) { const { ctx, chartArea: a, scales: { x } } = c; const px = x.getPixelForValue(baseIdx); ctx.save(); ctx.strokeStyle = "#1f2e3b"; ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke(); ctx.restore(); } };
  const ds = v === "ratio"
    ? [{ label: "Women per 1,000 men", data: rows.map(r => r.women_per_1000_men), borderColor: "#1f2e3b", borderWidth: 2.2, pointRadius: 0 }]
    : [{ label: "Men", data: rows.map(r => r[key[0]]), borderColor: MEN, backgroundColor: MEN, borderWidth: 2.4, pointRadius: 0 },
       { label: "Women", data: rows.map(r => r[key[1]]), borderColor: WOMEN, backgroundColor: WOMEN, borderWidth: 2.4, pointRadius: 0 }];
  mkChart("popsex", $("#popSexChart"), {
    type: "line", data: { labels: years, datasets: ds }, plugins: [line],
    options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
      scales: { y: { ticks: { callback: x => v === "ratio" ? fmt(x) : `${millions(x)} M` } }, x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 14 } } },
      plugins: { legend: { position: "bottom", labels: { boxWidth: 14, boxHeight: 2 } }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${fmt(c.raw)}` } } } },
  });
}
$$('input[name="psView"]').forEach(r => r.addEventListener("change", renderPopSex));

/* ------------------------------------------------------------------ age tree */
const tree = { year: null, timer: null, minis: {} };

function groupArr(arr, w) {
  if (w === 1) return arr.slice();
  const out = [];
  for (let g = 0; g < 18; g++) out.push(arr.slice(g * 5, g * 5 + 5).reduce((a, b) => a + b, 0));
  out.push(arr[90]);
  return out;
}
function bandLabels(w) {
  return w === 1 ? Array.from({ length: 91 }, (_, i) => (i === 90 ? "90+" : String(i)))
    : [...Array.from({ length: 18 }, (_, g) => `${g * 5}–${g * 5 + 4}`), "90+"];
}
function retAges(y) {
  const bs = state.result && state.result.by_sex;
  const m = bs && bs.ret_age_men ? bs.ret_age_men[y] : null, f = bs && bs.ret_age_women ? bs.ret_age_women[y] : null;
  return { M: m ?? 65, F: f ?? 65 };
}
function atOrAbove(arr, age) {
  const lo = Math.floor(age), frac = age - lo;
  let s = 0;
  for (let a = lo + (frac > 0 ? 1 : 0); a < arr.length; a++) s += arr[a];
  if (frac > 0) s += (1 - frac) * arr[lo];
  return s;
}

function setupTree() {
  const pop = state.pop;
  const years = Object.keys(pop.pyramids).map(Number).sort((a, b) => a - b);
  tree.years = years;
  const s = $("#treeYear");
  s.min = years[0]; s.max = years.at(-1);
  if (!tree.year || tree.year > years.at(-1) || tree.year < years[0]) tree.year = pop.base_year;
  s.value = tree.year;
  // tick marks on the slider: observed / projection boundary and milestones
  const span = years.at(-1) - years[0];
  const marks = [];
  [pop.base_year, years[0], years.at(-1), 2000, 2010, 2030, 2040, 2050, 2060].forEach(y => {
    if (y >= years[0] && y <= years.at(-1) && marks.every(m => Math.abs(m - y) / (years.at(-1) - years[0]) > 0.07)) marks.push(y);
  });
  $("#treeScale").innerHTML = [...new Set(marks)].map(y => `<span class="${y === pop.base_year ? "base" : ""}" style="left:${(y - years[0]) / span * 100}%">${y}</span>`).join("");
  // compare options
  const sel = $("#treeCompare"), prev = sel.value;
  const opts = [["none", "Nothing"], ...[1990, 2001, 2012, pop.base_year, 2030, 2040, 2050, 2060, 2070].filter(y => pop.pyramids[y]).map(y => [String(y), `${y}${y > pop.base_year ? " (projection)" : ""}`])];
  if (Object.keys(pop.eurostat_pyramids || {}).length) opts.push(["eurostat", "Eurostat projection, same year"]);
  sel.innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  sel.value = opts.some(o => o[0] === prev) ? prev : String(pop.base_year);
  buildTreeChart();
  buildMinis();
  drawTree();
}

function treeMax(w) {
  let mx = 0;
  tree.years.forEach(y => { const p = state.pop.pyramids[y]; mx = Math.max(mx, ...groupArr(p.M, w), ...groupArr(p.F, w)); });
  return Math.ceil(mx / (w === 1 ? 10000 : 50000)) * (w === 1 ? 10000 : 50000);
}

function retLinePlugin(getAges, w) {
  return {
    id: "retline",
    afterDatasetsDraw(c) {
      if (!$("#treeShade").checked) return;
      const { ctx, chartArea: a, scales: { x, y } } = c;
      const top = w === 1 ? 90 : 18;
      const ages = getAges();
      ctx.save(); ctx.setLineDash([5, 4]); ctx.lineWidth = 1.2; ctx.strokeStyle = "#1f2e3b";
      ctx.font = "12px Archivo, sans-serif"; ctx.fillStyle = "#1f2e3b";
      [["M", a.left, x.getPixelForValue(0)], ["F", x.getPixelForValue(0), a.right]].forEach(([sx, x0, x1]) => {
        const idx = top - ages[sx] / w + 0.5;
        const py = y.getPixelForValue(idx);
        ctx.beginPath(); ctx.moveTo(x0, py); ctx.lineTo(x1, py); ctx.stroke();
        const txt = `retirement age ${Number(ages[sx]).toFixed(ages[sx] % 1 ? 1 : 0)}`;
        ctx.textAlign = sx === "M" ? "left" : "right";
        ctx.fillText(txt, sx === "M" ? x0 + 6 : x1 - 6, py - 5);
      });
      ctx.restore();
    },
  };
}

function buildTreeChart() {
  const w = Number($("#treeGroup").value);
  const labels = bandLabels(w).reverse();
  const xmax = treeMax(w);
  const common = { grouped: false, barPercentage: 1, categoryPercentage: w === 1 ? 1 : 0.92 };
  const outline = (label, color, dash) => ({ type: "line", indexAxis: "y", label, data: [], borderColor: color, borderWidth: 1.5, pointRadius: 0, stepped: "middle", fill: false, borderDash: dash });
  mkChart("tree", $("#treeChart"), {
    type: "bar",
    data: { labels, datasets: [
      { label: "Men", data: [], backgroundColor: [], ...common },
      { label: "Women", data: [], backgroundColor: [], ...common },
      outline("Compare men", "#1f2e3b", []), outline("Compare women", "#1f2e3b", []),
    ] },
    plugins: [retLinePlugin(() => retAges(tree.year), w)],
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false, axis: "y" },
      scales: {
        x: { min: -xmax, max: xmax, ticks: { callback: v => `${fmt(Math.abs(v) / 1000)}k` }, grid: { color: "#eef1f4" },
             title: { display: true, text: "← men      persons      women →", color: "#5d6b79" } },
        y: { ticks: { autoSkip: false, callback: (v, i) => w === 5 || labels[i] === "90+" || Number(labels[i]) % 5 === 0 ? labels[i] : "" }, grid: { display: false } },
      },
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 12, filter: i => i.datasetIndex < 2 || $("#treeCompare").value !== "none", generateLabels: ch => {
          const cmp = $("#treeCompare").value;
          return [{ text: "Men", fillStyle: MEN, strokeStyle: MEN, datasetIndex: 0 }, { text: "Women", fillStyle: WOMEN, strokeStyle: WOMEN, datasetIndex: 1 },
            ...(cmp !== "none" ? [{ text: `Outline: ${cmp === "eurostat" ? "Eurostat" : cmp}`, fillStyle: "transparent", strokeStyle: "#1f2e3b", lineWidth: 1.5, datasetIndex: 2 }] : [])];
        } } },
        tooltip: { callbacks: {
          title: c => `Age ${c[0].label}`,
          label: c => {
            if (c.datasetIndex > 1) return c.raw == null ? null : `${c.dataset.label}: ${fmt(Math.abs(c.raw))}`;
            const tot = state.pop.rows.find(r => r.year === tree.year).total;
            return `${c.dataset.label}: ${fmt(Math.abs(c.raw))} (${(Math.abs(c.raw) / tot * 100).toFixed(2)} % of population)`;
          },
          footer: c => { const m = Math.abs(c.find(x => x.datasetIndex === 0)?.raw || 0), f = c.find(x => x.datasetIndex === 1)?.raw || 0; return m ? `Total ${fmt(m + f)}; ${fmt(f / m * 1000)} women per 1,000 men` : ""; },
        } },
      },
    },
  });
}

function shade(color, light, n, cut, w) {
  // bars from index 0 (youngest) upward; ages at/above cut get the dark colour
  return Array.from({ length: n }, (_, i) => (i * w >= cut - 1e-9 ? color : light));
}

function compareData(y) {
  const v = $("#treeCompare").value, pop = state.pop;
  if (v === "none") return null;
  if (v === "eurostat") return (pop.eurostat_pyramids || {})[y] || null;
  return Number(v) === y ? null : pop.pyramids[v];
}

function drawTree() {
  const pop = state.pop, ch = state.popCharts.tree;
  if (!pop || !ch) return;
  const y = tree.year, p = pop.pyramids[y], w = Number($("#treeGroup").value);
  const M = groupArr(p.M, w), F = groupArr(p.F, w), n = M.length;
  const ra = retAges(y), sh = $("#treeShade").checked;
  const rev = a => [...a].reverse();
  ch.data.datasets[0].data = rev(M.map(v => -v));
  ch.data.datasets[1].data = rev(F);
  ch.data.datasets[0].backgroundColor = rev(sh ? shade("#24507f", "#8fb0d3", n, ra.M, w) : Array(n).fill(MEN));
  ch.data.datasets[1].backgroundColor = rev(sh ? shade("#8a2f66", "#dca9c6", n, ra.F, w) : Array(n).fill(WOMEN));
  const c = compareData(y);
  ch.data.datasets[2].data = c ? rev(groupArr(c.M, w).map(v => -v)) : [];
  ch.data.datasets[3].data = c ? rev(groupArr(c.F, w)) : [];
  const cv = $("#treeCompare").value;
  ch.data.datasets[2].label = ch.data.datasets[3].label = cv === "eurostat" ? "Eurostat" : cv;
  ch.update("none");
  $("#treeYearOut").textContent = y;
  $("#treeTitle").textContent = `Age tree of Hungary, 1 January ${y}${p.type === "observed" ? "" : " (projection)"}`;
  $("#treeNote").textContent = p.type === "observed"
    ? `Observed: ${p.source}. Darker bars: at or above the retirement age of ${y} (men ${ra.M}, women ${ra.F}).`
    : `Cohort-component projection with the settings in the sidebar. Darker bars: at or above the retirement age of ${y} (${ra.M}).`;
  renderTreeSide(y, p, ra);
  renderTreeTable(y, p, w, c);
  $$(".mini").forEach(el => el.classList.toggle("sel", Number(el.dataset.year) === y));
}

function renderTreeSide(y, p, ra) {
  const r = state.pop.rows.find(x => x.year === y);
  const elM = atOrAbove(p.M, ra.M), elF = atOrAbove(p.F, ra.F);
  const res = state.result, bs = res && res.by_sex;
  let pens = null;
  if (bs && bs.available) {
    let i = bs.hist_years.indexOf(y);
    if (i >= 0) pens = { m: bs.men[i], f: bs.women[i], obs: true };
    i = bs.future_years.indexOf(y);
    if (i >= 0) pens = { m: bs.men_pred[i], f: bs.women_pred[i], obs: false };
  }
  const grp = [["0–14", "age_0_14"], ["15–64", "age_15_64"], ["65+", "age_65_plus"], ["80+", "age_80_plus"]];
  $("#treeSide").innerHTML = `
    <div class="big">
      <div class="all"><span>Population</span><b>${fmt(r.total)}</b><span>median age ${r.median_age.toFixed(1)}, ${fmt(r.women_per_1000_men)} women per 1,000 men</span></div>
      <div class="m"><span>Men</span><b>${fmt(r.male)}</b><span>${(100 - r.share_women).toFixed(1)} %</span></div>
      <div class="f"><span>Women</span><b>${fmt(r.female)}</b><span>${r.share_women.toFixed(1)} %</span></div>
    </div>
    <h3>Age groups by sex</h3>
    <table class="num"><thead><tr><th>Age</th><th>Men</th><th>Women</th><th>Share</th></tr></thead><tbody>
      ${grp.map(([l, k]) => `<tr><td>${l}</td><td>${fmt(r[k + "_m"])}</td><td>${fmt(r[k + "_f"])}</td><td>${(r[k] / r.total * 100).toFixed(1)} %</td></tr>`).join("")}
    </tbody></table>
    <h3>At or above retirement age</h3>
    <table class="num"><tbody>
      <tr><td>Men (${ra.M}+)</td><td>${fmt(elM)}</td></tr>
      <tr><td>Women (${ra.F}+)</td><td>${fmt(elF)}</td></tr>
      <tr><td>Per 100 aged 15–64</td><td>${((elM + elF) / r.age_15_64 * 100).toFixed(1)}</td></tr>
    </tbody></table>
    ${pens ? `<h3>${res.target_label}${pens.obs ? " (KSH)" : " (forecast)"}</h3>
    <table class="num"><tbody>
      <tr><td class="men">Men</td><td>${fmt(pens.m)}</td></tr>
      <tr><td class="women">Women</td><td>${fmt(pens.f)}</td></tr>
      <tr><td>Women's share</td><td>${(pens.f / (pens.m + pens.f) * 100).toFixed(1)} %</td></tr>
    </tbody></table>` : `<p class="sub">Recipients by sex are published from 2000; forecasts cover ${bs && bs.future_years ? bs.future_years[0] + "–" + bs.future_years.at(-1) : "the forecast years"}.</p>`}`;
}

function renderTreeTable(y, p, w, c) {
  const labels = bandLabels(w), M = groupArr(p.M, w), F = groupArr(p.F, w);
  const cM = c ? groupArr(c.M, w) : null, cF = c ? groupArr(c.F, w) : null;
  const tot = M.reduce((a, b) => a + b, 0) + F.reduce((a, b) => a + b, 0);
  const ra = retAges(y);
  const cv = $("#treeCompare").value, cl = cv === "eurostat" ? "Eurostat" : cv;
  $("#treeTableTitle").textContent = `Exact figures, 1 January ${y}${c ? `, compared with ${cl}` : ""}`;
  let h = `<thead><tr><th>Age</th><th>Men</th><th>Women</th><th>Total</th><th>% of population</th><th>Women per 1,000 men</th>${c ? `<th>Total ${cl}</th><th>Change</th>` : ""}</tr></thead><tbody>`;
  const retIdx = Math.ceil(Math.min(ra.M, ra.F) / w - 1e-9);
  for (let i = labels.length - 1; i >= 0; i--) {
    const t = M[i] + F[i];
    const ct = c ? cM[i] + cF[i] : null, chg = c ? (t / ct * 100 - 100) : null;
    h += `<tr class="${i === retIdx - 1 ? "retage" : ""}"><td>${labels[i]}</td><td>${fmt(M[i])}</td><td>${fmt(F[i])}</td><td>${fmt(t)}</td><td>${(t / tot * 100).toFixed(2)}</td><td>${M[i] ? fmt(F[i] / M[i] * 1000) : ""}</td>${c ? `<td>${fmt(ct)}</td><td class="${chg >= 0 ? "pos" : "neg"}">${chg >= 0 ? "+" : "–"}${Math.abs(chg).toFixed(1)} %</td>` : ""}</tr>`;
  }
  const sM = M.reduce((a, b) => a + b, 0), sF = F.reduce((a, b) => a + b, 0);
  h += `<tr class="milestone"><td>Total</td><td>${fmt(sM)}</td><td>${fmt(sF)}</td><td>${fmt(sM + sF)}</td><td>100.00</td><td>${fmt(sF / sM * 1000)}</td>${c ? `<td>${fmt(cM.reduce((a, b) => a + b, 0) + cF.reduce((a, b) => a + b, 0))}</td><td></td>` : ""}</tr>`;
  $("#treeTable").innerHTML = h + "</tbody>";
}

function buildMinis() {
  const pop = state.pop, host = $("#treeMinis");
  Object.values(tree.minis).forEach(c => c.destroy());
  tree.minis = {};
  const ys = [pop.base_year, 2030, 2040, 2050, 2060, 2070].filter(y => pop.pyramids[y]).slice(0, 5);
  if (!ys.includes(1990) && pop.pyramids[1990]) ys.unshift(1990);
  host.innerHTML = ys.map(y => { const r = pop.rows.find(x => x.year === y); return `<button class="mini" data-year="${y}" aria-label="Open the ${y} age tree"><div class="mh"><b>${y}</b><span>${millions(r.total)} M, ${r.share_65_plus.toFixed(0)} % 65+</span></div><div class="cw"><canvas></canvas></div></button>`; }).join("");
  const xmax = treeMax(5);
  $$(".mini", host).forEach(el => {
    const y = Number(el.dataset.year), p = pop.pyramids[y], ra = retAges(y);
    const M = groupArr(p.M, 5), F = groupArr(p.F, 5), rev = a => [...a].reverse();
    tree.minis[y] = new Chart($("canvas", el), {
      type: "bar",
      data: { labels: rev(bandLabels(5)), datasets: [
        { data: rev(M.map(v => -v)), backgroundColor: rev(shade("#24507f", "#8fb0d3", 19, ra.M, 5)), grouped: false, barPercentage: 1, categoryPercentage: 0.9 },
        { data: rev(F), backgroundColor: rev(shade("#8a2f66", "#dca9c6", 19, ra.F, 5)), grouped: false, barPercentage: 1, categoryPercentage: 0.9 },
      ] },
      options: { indexAxis: "y", responsive: true, maintainAspectRatio: false, animation: false, events: [],
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false, min: -xmax, max: xmax }, y: { display: false } } },
    });
    el.addEventListener("click", () => { tree.year = y; $("#treeYear").value = y; drawTree(); window.scrollTo({ top: 0, behavior: "smooth" }); });
  });
}

$("#treeYear").addEventListener("input", e => { tree.year = Number(e.target.value); drawTree(); });
$("#treeGroup").addEventListener("change", () => { buildTreeChart(); drawTree(); });
$("#treeCompare").addEventListener("change", drawTree);
$("#treeShade").addEventListener("change", drawTree);
$("#treePlay").addEventListener("click", () => {
  const btn = $("#treePlay"), s = $("#treeYear");
  if (tree.timer) { clearInterval(tree.timer); tree.timer = null; btn.textContent = "Play"; return; }
  if (tree.year >= Number(s.max)) tree.year = Number(s.min);
  btn.textContent = "Pause";
  tree.timer = setInterval(() => {
    if (tree.year >= Number(s.max)) { clearInterval(tree.timer); tree.timer = null; btn.textContent = "Play"; return; }
    tree.year += 1; s.value = tree.year; drawTree();
  }, 170);
});
$("#treeCsv").addEventListener("click", e => {
  e.preventDefault();
  if (!state.pop || !tree.year) { toast("The age tree is still loading."); return; }
  const y = tree.year, p = state.pop.pyramids[y], w = Number($("#treeGroup").value);
  const L = bandLabels(w), M = groupArr(p.M, w), F = groupArr(p.F, w);
  const csv = ["year,age,men,women,total,type", ...L.map((l, i) => `${y},${l},${Math.round(M[i])},${Math.round(F[i])},${Math.round(M[i] + F[i])},${p.type}`)].join("\n");
  saveBlob(new Blob([csv], { type: "text/csv" }), `age_tree_${y}${w === 5 ? "_5yr" : ""}.csv`);
});

/* ------------------------------------------------------------------ population tab */
const MEN = "#3d6fa5", WOMEN = "#b0558a";
state.popCharts = {};
const ageLabels = Array.from({ length: 91 }, (_, i) => (i === 90 ? "90+" : String(i))).reverse();

function mkChart(key, canvas, cfg) {
  if (state.popCharts[key]) state.popCharts[key].destroy();
  state.popCharts[key] = new Chart(canvas, cfg);
  return state.popCharts[key];
}

function renderPopulation(pop) {
  if (!pop) return;
  state.pop = pop;
  const rows = pop.rows;
  const byYear = Object.fromEntries(rows.map(r => [r.year, r]));
  const base = pop.base_year;
  const a = pop.assumptions;
  $("#popStatus").textContent = `Observed age structure ${rows[0].year}–${base} (KSH), cohort-component projection ${base + 1}–${rows.at(-1).year}.`;
  $("#popAssumptions").textContent = `Fertility ${a.tfr_start.toFixed(2)} → ${a.tfr_target.toFixed(2)} by ${a.tfr_target_year}; net migration ${fmt(a.net_migration)} a year; life expectancy at birth from ${a.e0_m_start.toFixed(1)} (men) and ${a.e0_f_start.toFixed(1)} (women). Band: ${a.variants}.`;

  // milestone rail
  const ms = [base, 2030, 2040, 2050, 2060, 2070].filter(y => byYear[y]).slice(0, 4);
  $("#popMilestones").innerHTML = ms.map(y => {
    const r = byYear[y], b = byYear[base];
    const chg = (r.total / b.total * 100 - 100);
    return `<li class="${r.type === "observed" ? "obs" : ""}"><div class="yr">${y}${r.type === "observed" ? " observed" : ""}</div>
      <div class="val">${millions(r.total)}<small>million</small></div>
      <div class="chg">${y === base ? "KSH, 1 January" : `${chg >= 0 ? "+" : "–"}${Math.abs(chg).toFixed(1)} % vs ${base}`}</div>
      <div class="rng">${r.share_65_plus.toFixed(1)} % aged 65+, ${r.share_0_14.toFixed(1)} % under 15</div>
      <div class="rng">${r.old_age_dependency.toFixed(1)} aged 65+ per 100 aged 15–64, median age ${r.median_age.toFixed(1)}</div></li>`;
  }).join("");

  // total population chart
  const years = rows.map(r => r.year);
  const obs = rows.map(r => r.type === "observed" ? r.total : null);
  const prj = rows.map(r => r.type === "projection" || r.year === base ? r.total : null);
  const lo = rows.map(r => r.total_low ?? (r.year === base ? r.total : null));
  const hi = rows.map(r => r.total_high ?? (r.year === base ? r.total : null));
  const ds = [
    { label: "Low variant", data: lo, borderWidth: 0, pointRadius: 0, fill: false },
    { label: "Low–high variants", data: hi, borderWidth: 0, pointRadius: 0, fill: "-1", backgroundColor: "rgba(61,111,165,.14)" },
    { label: "Observed (KSH)", data: obs, borderColor: "#2c5e4c", backgroundColor: "#2c5e4c", borderWidth: 2.6, pointRadius: 0 },
    { label: "Cohort-component projection", data: prj, borderColor: MEN, backgroundColor: MEN, borderWidth: 2.6, pointRadius: 0 },
  ];
  const es = pop.eurostat_totals || {};
  if (Object.keys(es).length) ds.push({ label: "Eurostat EUROPOP", data: years.map(y => es[y] ?? null), borderColor: "#8a5a9e", borderDash: [6, 4], borderWidth: 1.6, pointRadius: 0 });
  const fb = pop.fallback_totals || {};
  if (Object.keys(fb).length) ds.push({ label: "Fallback path (UN trend)", data: years.map(y => fb[y] ?? null), borderColor: "#8a96a3", borderDash: [2, 3], borderWidth: 1.4, pointRadius: 0, hidden: true });
  mkChart("total", $("#popChart"), {
    type: "line", data: { labels: years, datasets: ds },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
      scales: { y: { ticks: { callback: v => `${(v / 1e6).toFixed(1)} M` }, grid: { color: "#e6eaee" } }, x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 14 } } },
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 14, boxHeight: 2, filter: i => i.text !== "Low variant" } },
        tooltip: { filter: i => i.raw !== null && i.dataset.label !== "Low variant", callbacks: { label: c => `${c.dataset.label}: ${fmt(c.raw)}` } },
      },
    },
  });

  renderAgeGroups();
  renderPopSex();
  setupTree();
  renderPopTable();
  renderValidation(pop.validation);
}

function renderAgeGroups() {
  const pop = state.pop; if (!pop) return;
  const share = $('input[name="agView"]:checked').value === "share";
  const rows = pop.rows, years = rows.map(r => r.year);
  const groups = [["0–14", "age_0_14", "share_0_14", "#c9a24a"], ["15–64", "age_15_64", "share_15_64", "#9fb4c7"], ["65–79", null, null, "#d98b7f"], ["80+", "age_80_plus", "share_80_plus", "#b13a2f"]];
  const val = (r, g) => {
    if (g[0] === "65–79") return share ? r.share_65_plus - r.share_80_plus : r.age_65_plus - r.age_80_plus;
    return share ? r[g[2]] : r[g[1]];
  };
  const baseIdx = years.indexOf(pop.base_year);
  const line = { id: "baseLine", afterDraw(c) { const { ctx, chartArea: a, scales: { x } } = c; const px = x.getPixelForValue(baseIdx); ctx.save(); ctx.strokeStyle = "#1f2e3b"; ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke(); ctx.restore(); } };
  mkChart("age", $("#ageChart"), {
    type: "line",
    data: { labels: years, datasets: groups.map(g => ({ label: g[0], data: rows.map(r => val(r, g)), fill: true, backgroundColor: g[3], borderColor: g[3], pointRadius: 0, borderWidth: 1 })) },
    plugins: [line],
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
      scales: { y: { stacked: true, min: 0, max: share ? 100 : undefined, ticks: { callback: v => share ? `${v} %` : `${(v / 1e6).toFixed(0)} M` } }, x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 14 } } },
      plugins: { legend: { position: "bottom", labels: { boxWidth: 12 } }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${share ? c.raw.toFixed(1) + " %" : fmt(c.raw)}` } } },
    },
  });
}
$$('input[name="agView"]').forEach(r => r.addEventListener("change", renderAgeGroups));

function renderPopTable() {
  const rows = state.pop.rows, ms = new Set([2030, 2040, 2050, 2060, 2070, state.pop.base_year]);
  let h = `<thead><tr><th>Year</th><th>Population</th><th>0–14</th><th>15–64</th><th>65+</th><th>65+ %</th><th>Old-age dep.</th><th>Median age</th><th>Births</th><th>Deaths</th><th>Net migration</th><th>TFR</th><th>e0 men</th><th>e0 women</th></tr></thead><tbody>`;
  rows.forEach(r => {
    h += `<tr class="${ms.has(r.year) ? "milestone" : ""} ${r.type === "observed" ? "obsrow" : ""}" title="${r.age_source}"><td>${r.year}</td><td>${fmt(r.total)}</td><td>${fmt(r.age_0_14)}</td><td>${fmt(r.age_15_64)}</td><td>${fmt(r.age_65_plus)}</td><td>${r.share_65_plus.toFixed(1)}</td><td>${r.old_age_dependency.toFixed(1)}</td><td>${r.median_age.toFixed(1)}</td><td>${fmt(r.births)}</td><td>${fmt(r.deaths)}</td><td>${fmt(r.net_migration)}</td><td>${fmt(r.tfr, 2)}</td><td>${fmt(r.e0_m, 1)}</td><td>${fmt(r.e0_f, 1)}</td></tr>`;
  });
  $("#popTable").innerHTML = h + "</tbody>";
}

function renderValidation(v) {
  if (!v || !v.rows) { $("#valIntro").textContent = "Back-test needs the KSH 2016 and 2026 age structures."; return; }
  $("#valIntro").textContent = `The engine starts from the KSH population of 1 January 2016 and uses the observed fertility, life expectancy and implied net migration of each year. Mean absolute error across single ages: ${v.age_mape.toFixed(2)} %.`;
  $("#valTable").innerHTML = `<thead><tr><th>${v.period}</th><th>Projected</th><th>Observed</th><th>Error</th></tr></thead><tbody>` +
    v.rows.map(r => `<tr><td>${r.indicator}</td><td>${fmt(r.projected)}</td><td>${fmt(r.observed)}</td><td>${r.error_pct >= 0 ? "+" : "–"}${Math.abs(r.error_pct).toFixed(2)} %</td></tr>`).join("") + "</tbody>";
  mkChart("val", $("#valChart"), {
    type: "bar",
    data: { labels: ageLabels.slice().reverse(), datasets: [{ label: "Absolute error by age (%)", data: v.age_error_by_age, backgroundColor: "#8a96a3", barPercentage: 1, categoryPercentage: 1 }] },
    options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false }, tooltip: { callbacks: { title: c => `Age ${c[0].label}`, label: c => `${c.raw.toFixed(2)} %` } } },
      scales: { x: { ticks: { autoSkip: false, callback: (v, i) => i % 10 === 0 ? i : "" }, grid: { display: false } }, y: { ticks: { callback: v => `${v} %` } } } },
  });
}

function renderChart(r) {
  const years = [...r.hist_years, ...r.future_years];
  const nH = r.hist_years.length;
  const pad = arr => [...Array(nH).fill(null), ...arr];
  const lastObs = r.hist_values.at(-1);
  const joinF = arr => { const a = pad(arr); a[nH - 1] = lastObs; return a; }; // connect forecast to last observation
  const ds = [
    { label: "Interval low", data: joinF(r.ensemble.lo), borderWidth: 0, pointRadius: 0, fill: false, _band: true },
    { label: "Prediction interval", data: joinF(r.ensemble.hi), borderWidth: 0, pointRadius: 0, backgroundColor: "rgba(177,58,47,.13)", fill: "-1", _band: true },
    { label: "Observed (KSH)", data: [...r.hist_values, ...Array(r.future_years.length).fill(null)], borderColor: "#2c5e4c", backgroundColor: "#2c5e4c", borderWidth: 2.6, pointRadius: 0, pointHoverRadius: 4 },
  ];
  r.enabled.filter(k => r.models[k].ok).forEach(k => ds.push({
    label: r.models[k].label, data: joinF(r.models[k].pred), borderColor: MODEL_COLORS[k], backgroundColor: MODEL_COLORS[k],
    borderWidth: 1.3, borderDash: [5, 4], pointRadius: 0, pointHoverRadius: 3,
  }));
  ds.push({ label: "Ensemble forecast", data: joinF(r.ensemble.pred), borderColor: "#b13a2f", backgroundColor: "#b13a2f", borderWidth: 3, pointRadius: 0, pointHoverRadius: 4 });
  ds.push({ label: "Back-test (ensemble)", data: years.map(y => { const i = r.ensemble_backtest.years.indexOf(y); return i >= 0 ? r.ensemble_backtest.pred[i] : null; }),
            borderColor: "#1f2e3b", borderWidth: 1.2, borderDash: [2, 3], pointRadius: 2, hidden: false });

  const milestoneYears = r.milestones.map(m => m.year);
  const guide = {
    id: "guide",
    afterDraw(c) {
      const { ctx, chartArea: a, scales: { x } } = c;
      ctx.save();
      ctx.strokeStyle = "#8a96a3"; ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
      milestoneYears.forEach(y => { const px = x.getPixelForValue(years.indexOf(y)); ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke(); });
      const px = x.getPixelForValue(nH - 1);
      ctx.setLineDash([]); ctx.strokeStyle = "#1f2e3b"; ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke();
      ctx.fillStyle = "#5d6b79"; ctx.font = "12px Archivo, sans-serif";
      ctx.fillText("forecast →", px + 6, a.top + 14);
      ctx.restore();
    },
  };
  if (state.chart) state.chart.destroy();
  state.chart = new Chart($("#chart"), {
    type: "line",
    data: { labels: years, datasets: ds },
    plugins: [guide],
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, spanGaps: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        y: { ticks: { callback: v => `${millions(v)} M` }, grid: { color: "#e6eaee" } },
        x: { ticks: { maxRotation: 0, autoSkip: true, autoSkipPadding: 14 }, grid: { display: false } },
      },
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 14, boxHeight: 2, filter: i => i.text !== "Interval low" } },
        tooltip: {
          filter: i => i.raw !== null && i.dataset.label !== "Interval low",
          callbacks: { label: c => `${c.dataset.label}: ${fmt(c.raw)}` },
        },
      },
    },
  });
}

function renderMilestones(r) {
  const el = $("#milestones");
  el.innerHTML = "";
  const all = r.milestones.flatMap(m => [m.lo, m.hi]);
  const lo = Math.min(...all), hi = Math.max(...all);
  const pos = v => ((v - lo) / (hi - lo || 1)) * 100;
  r.milestones.forEach(m => {
    const li = document.createElement("li");
    const dir = m.change_pct < 0 ? "down" : "up";
    li.innerHTML = `<div class="yr">${m.year}</div>
      <div class="val">${millions(m.value)}<small>million</small></div>
      <div class="chg ${dir}">${m.change_pct >= 0 ? "+" : "–"}${Math.abs(m.change_pct).toFixed(1)} % vs ${r.last_actual.year}</div>
      <div class="rng">Range ${fmt(m.lo)} to ${fmt(m.hi)}</div>
      ${m.men != null ? `<div class="sx"><b class="men">${millions(m.men)} M men</b>, <b class="women">${millions(m.women)} M women</b></div>` : ""}
      <div class="rng">${m.per_1000.toFixed(0)} per 1,000 residents, retirement age ${m.retirement_age.toFixed(1)}</div>
      <div class="rangebar" aria-hidden="true"><span style="left:${pos(m.lo)}%;width:${pos(m.hi) - pos(m.lo)}%"></span><i style="left:${pos(m.value)}%"></i></div>`;
    el.appendChild(li);
  });
}

function renderMetrics(r) {
  const rows = r.enabled.map(k => ({ k, ...r.models[k] }));
  const best = rows.filter(x => x.ok).sort((a, b) => a.metrics.mape - b.metrics.mape)[0];
  let h = `<thead><tr><th>Model</th><th>Weight</th><th>MAE</th><th>RMSE</th><th>MAPE</th></tr></thead><tbody>`;
  rows.forEach(x => {
    if (!x.ok) { h += `<tr><td>${x.label}</td><td class="fail" colspan="4">Skipped: ${x.error}</td></tr>`; return; }
    h += `<tr class="${best && x.k === best.k ? "best" : ""}"><td>${x.label}</td><td>${(r.weights[x.k] * 100).toFixed(1)} %</td><td>${fmt(x.metrics.mae)}</td><td>${fmt(x.metrics.rmse)}</td><td>${x.metrics.mape.toFixed(2)} %</td></tr>`;
  });
  const em = r.ensemble_metrics;
  h += `<tr class="milestone"><td>Ensemble</td><td>100 %</td><td>${fmt(em.mae)}</td><td>${fmt(em.rmse)}</td><td>${em.mape.toFixed(2)} %</td></tr></tbody>`;
  $("#metricsTable").innerHTML = h;
}

function renderYearTable(r) {
  const ok = r.enabled.filter(k => r.models[k].ok);
  const short = { arima: "ARIMA", ets: "Holt", structural: "Ratio", rf: "Forest", gb: "Boost", ridge: "Ridge", mlp: "MLP" };
  const ms = new Set(r.milestones.map(m => m.year));
  const bs = r.by_sex && r.by_sex.available ? r.by_sex : null;
  let h = `<thead><tr><th>Year</th><th>Ensemble</th>${bs ? "<th>Men</th><th>Women</th>" : ""}<th>Low</th><th>High</th>${ok.map(k => `<th>${short[k]}</th>`).join("")}<th>65+ pop.</th><th>Ret. age</th></tr></thead><tbody>`;
  r.future_years.forEach((y, i) => {
    const ex = r.future_exog[i];
    h += `<tr class="${ms.has(y) ? "milestone" : ""}"><td>${y}</td><td>${fmt(r.ensemble.pred[i])}</td>${bs ? `<td>${fmt(bs.men_pred[i])}</td><td>${fmt(bs.women_pred[i])}</td>` : ""}<td>${fmt(r.ensemble.lo[i])}</td><td>${fmt(r.ensemble.hi[i])}</td>${ok.map(k => `<td>${fmt(r.models[k].pred[i])}</td>`).join("")}<td>${fmt(ex.pop_65plus)}</td><td>${fmt(ex.retirement_age, 2)}</td></tr>`;
  });
  $("#yearTable").innerHTML = h + "</tbody>";
}

/* ------------------------------------------------------------------ saving files
   Files are built in this browser and downloaded as usual. */
function toast(msg, ms = 3800) {
  let el = $("#toast");
  if (!el) { el = Object.assign(document.createElement("div"), { id: "toast", role: "status" }); document.body.appendChild(el); }
  el.textContent = msg; el.classList.add("show");
  clearTimeout(el._t); if (ms) el._t = setTimeout(() => el.classList.remove("show"), ms);
}

async function saveBlob(blob, name) {
  if (PS.config.preview) { toast(`${name} is ready (${Math.max(1, Math.round(blob.size / 1024))} KB). Downloads are switched off in this preview; they work on your own site.`, 6000); return; }
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

let saving = false;
async function saveFromUrl(url, opts = {}) {
  if (saving) { toast("Still preparing the previous file…"); return; }
  saving = true;
  const heavy = /(xlsx|pdf|csvzip)$/.test(url);
  if (heavy) { toast("Preparing the file…", 0); await paint(); }
  try {
    const { blob, name } = await PS.api.file(url, opts);
    await saveBlob(blob, name);
    if (heavy && !PS.config.preview) toast(`Saved ${name}`);
  } catch (e) { console.error(e); toast(e.message); }
  finally { saving = false; }
}

/* in-page confirmation (browser dialogs are avoided) */
function ask(msg, okText = "Yes") {
  return new Promise(res => {
    const d = document.createElement("div");
    d.className = "askbox"; d.setAttribute("role", "alertdialog"); d.setAttribute("aria-modal", "true");
    d.innerHTML = `<div class="askcard"><p></p><div class="btnrow"><button class="primary" data-a="1"></button><button class="ghost" data-a="0">Cancel</button></div></div>`;
    $("p", d).textContent = msg; $("[data-a='1']", d).textContent = okText;
    const done = v => { d.remove(); document.removeEventListener("keydown", onKey); res(v); };
    const onKey = e => { if (e.key === "Escape") done(false); };
    d.addEventListener("click", e => { const b = e.target.closest("[data-a]"); if (b) done(b.dataset.a === "1"); else if (e.target === d) done(false); });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(d); $("[data-a='1']", d).focus();
  });
}

/* ------------------------------------------------------------------ exports */
$$(".exp[data-fmt]").forEach(a => a.addEventListener("click", e => {
  e.preventDefault();
  if (!state.runId) return;
  saveFromUrl(`/api/export/${state.runId}/${a.dataset.fmt}`);
}));
// plain download links (template, merged data)
document.addEventListener("click", e => {
  const a = e.target.closest("[data-file]");
  if (!a) return;
  e.preventDefault();
  saveFromUrl(a.dataset.file === "/api/data/download" ? `${a.dataset.file}?variant=${state.settings.projection_variant}` : a.dataset.file);
});

function download(url, body) {
  return saveFromUrl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
$$("[data-save-settings]").forEach(b => b.addEventListener("click", () =>
  download(`/api/settings/export/${b.dataset.saveSettings}`, state.settings)));

$("#settingsFile").addEventListener("change", async e => {
  const f = e.target.files[0];
  if (!f) return;
  const fd = new FormData(); fd.append("file", f);
  try {
    const res = await api("/api/settings/import", { method: "POST", body: fd });
    applySettings(res.settings);
    setStatus(`Loaded settings from ${f.name}.`);
    runSimulation();
  } catch (err) { setStatus(err.message, true); }
  e.target.value = "";
});
$("#resetSettings").addEventListener("click", () => { applySettings(state.defaults); runSimulation(); });
$("#runBtn").addEventListener("click", runSimulation);

/* ------------------------------------------------------------------ data tab */
const SRC_CLASS = s => !s ? "" : s === "default" ? "s-default" : s === "user" ? "s-user" : s === "interpolated" ? "s-interpolated" : s === "derived" ? "s-derived" : "s-online";

function renderData() {
  const d = state.data;
  if (!d) return;
  const view = $('input[name="dview"]:checked').value;
  const decimals = { share_65plus: 2, life_expectancy: 2, retirement_age: 2 };
  let h = `<thead><tr><th>Year</th>${d.columns.map(c => `<th title="${c}">${d.labels[c]}</th>`).join("")}</tr></thead><tbody>`;
  d.rows.forEach(row => {
    const proj = row.year > d.last_hist_year;
    if ((view === "hist" && proj) || (view === "proj" && !proj)) return;
    const sep = row.year === d.last_hist_year + 1 ? " sep" : "";
    h += `<tr class="${proj ? "proj" : ""}${sep}"><td>${row.year}</td>`;
    d.columns.forEach(c => {
      const key = `${row.year}|${c}`;
      const edited = state.edits.has(key);
      const v = edited ? state.edits.get(key) : row.values[c];
      const shown = v === null || v === undefined || v === "" ? "" : (decimals[c] ? Number(v).toFixed(decimals[c]) : Math.round(v));
      h += `<td class="${SRC_CLASS(row.source[c])}${edited ? " changed" : ""}" title="${row.source[c] || "empty"}"><input data-key="${key}" value="${shown}" inputmode="decimal" aria-label="${d.labels[c]} ${row.year}"></td>`;
    });
    h += "</tr>";
  });
  $("#dataTable").innerHTML = h + "</tbody>";
  $("#saveEdits").disabled = state.edits.size === 0;
  if (d.refresh && !$("#refreshReport").children.length) renderReport(d.refresh);
}

$("#dataTable").addEventListener("change", e => {
  const inp = e.target.closest("input[data-key]");
  if (!inp) return;
  const raw = inp.value.replace(/\s/g, "").replace(",", ".");
  if (raw !== "" && Number.isNaN(Number(raw))) { inp.value = ""; return; }
  state.edits.set(inp.dataset.key, raw === "" ? "" : Number(raw));
  inp.parentElement.classList.add("changed");
  $("#saveEdits").disabled = false;
});
$$('input[name="dview"]').forEach(r => r.addEventListener("change", renderData));

$("#saveEdits").addEventListener("click", async () => {
  const edits = [...state.edits].map(([k, value]) => { const [year, column] = k.split("|"); return { year: Number(year), column, value }; });
  try {
    const res = await api("/api/data/edit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ edits, variant: state.settings.projection_variant }) });
    state.edits.clear(); state.data = res.data; renderData();
    $("#uploadMsg").textContent = res.message;
    runSimulation();
  } catch (e) { $("#uploadMsg").textContent = e.message; }
});

$("#uploadForm").addEventListener("submit", async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  fd.append("variant", state.settings.projection_variant);
  $("#uploadMsg").textContent = "Reading the file…";
  try {
    const res = await api("/api/data/upload", { method: "POST", body: fd });
    state.data = res.data; renderData();
    $("#uploadMsg").textContent = res.message;
    e.target.reset();
    runSimulation();
  } catch (err) { $("#uploadMsg").textContent = err.message; }
});

$("#resetData").addEventListener("click", async () => {
  if (!(await ask("Remove every value you uploaded or edited in this browser?", "Remove my data"))) return;
  const res = await api("/api/data/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ variant: state.settings.projection_variant }) });
  state.edits.clear(); state.data = res.data; renderData();
  $("#uploadMsg").textContent = res.message;
  runSimulation();
});

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const when = t => { const d = new Date(t); return Number.isNaN(d.getTime()) ? esc(t) : d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }); };
function renderReport(rep) {
  if (!rep || !rep.sources) return;
  $("#refreshReport").innerHTML = (rep.note ? `<li>${esc(rep.note)}</li>` : "") + `<li>Last download: ${when(rep.time)}</li>` + rep.sources.map(s =>
    `<li><span class="${s.ok ? "ok" : "no"}">${s.ok ? "Loaded" : "Not loaded"}</span> ${esc(s.name)} – ${esc(s.detail)}</li>`).join("");
}

function renderSourceStatus() {
  const st = PS.api.status(), el = $("#dataMode"), b = $("#refreshBtn");
  let txt;
  if (st.preview) txt = "Preview: the bundled KSH tables are used. On your own PHP site the button below downloads the latest KSH and Eurostat tables for every visitor.";
  else if (st.mode === "file") txt = `Using KSH and Eurostat data downloaded automatically on ${when(st.meta && st.meta.time)}. New data is fetched by the site's scheduled update, so the button is off here.`;
  else if (st.mode === "static") txt = "api.php is not reachable, so the page uses the bundled KSH tables. Upload the site to a PHP host to download newer data.";
  else if (st.hasOfficial) txt = `Using data the server downloaded from KSH and Eurostat on ${when(st.meta && st.meta.time)}, shared by every visitor.`;
  else txt = "The server has not downloaded any data yet, so the bundled KSH tables are used. Press the button to download them once for all visitors.";
  if (st.server && st.server.can_download === false) txt += " Note: this server cannot open web addresses (enable curl or allow_url_fopen).";
  if (st.server && st.server.cache_writable === false) txt += " Note: the cache folder is not writable, so downloads cannot be stored.";
  el.textContent = txt;
  b.disabled = st.mode !== "php";
  $("#refreshKeyRow").hidden = !(st.server && st.server.refresh_needs_key);
}
window.addEventListener("ps-server", renderSourceStatus);

$("#refreshBtn").addEventListener("click", async () => {
  const b = $("#refreshBtn");
  b.disabled = true; b.textContent = "Downloading from KSH and Eurostat…";
  $("#refreshReport").innerHTML = `<li>This can take up to a minute.</li>`;
  try {
    const res = await api("/api/data/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ variant: state.settings.projection_variant, key: $("#refreshKey").value }) });
    state.data = res.data; renderData(); renderReport(res.report); renderSourceStatus();
    runSimulation();
  } catch (e) {
    if (e.needsKey) $("#refreshKeyRow").hidden = false;
    $("#refreshReport").innerHTML = `<li class="no">${esc(e.message)}</li>`;
  }
  finally { b.disabled = PS.api.status().mode !== "php"; b.textContent = "Download latest official data"; }
});

/* ------------------------------------------------------------------ boot */
(async function init() {
  try {
    await PS.api.boot();
    renderSourceStatus();
    const sp = await api("/api/settings/spec");
    state.spec = sp.spec; state.defaults = sp.defaults; state.settings = { ...sp.defaults };
    renderControls();
    state.data = await api("/api/data");
    renderData();
    await runSimulation();
  } catch (e) { setStatus(e.message, true); }
})();

/* ------------------------------------------------------------------ scenarios */
const scen = { params: [], cats: {}, sel: {}, values: {}, saved: [], runId: null, result: null, chart: null, imp: null };
const SCEN_COL = { baseline: "#1f2e3b", custom: "#c07f1d", optimistic: "#2c5e4c", pessimistic: "#b13a2f" };
const CAT_COL = { positive: "#2c5e4c", negative: "#b13a2f", neutral: "#7d8a97" };
const CAT_HEAD = {
  positive: ["Positive", "Expected to lower the burden"],
  negative: ["Negative", "Expected to raise the burden"],
  neutral: ["Neutral", "Mainly timing or structure"],
};

async function initScenarios() {
  const r = await api("/api/scenarios/params");
  scen.params = r.params; scen.cats = r.categories; scen.saved = r.saved;
  scen.params.forEach(p => { scen.values[p.key] = p.default; });
  renderScenCols(); renderSaved(); updateRunLabel();
}

function renderScenCols() {
  $("#scenCols").innerHTML = ["positive", "negative", "neutral"].map(cat => {
    const ps = scen.params.filter(p => p.category === cat);
    return `<section class="scol ${cat}" aria-label="${CAT_HEAD[cat][0]} parameters">
      <header><span class="count" id="cnt-${cat}"></span><h3>${CAT_HEAD[cat][0]}</h3><p>${CAT_HEAD[cat][1]}</p></header>
      ${ps.map(p => {
        const fixed = p.min === p.max;
        return `<div class="sparam" data-key="${p.key}">
          <label><input type="checkbox" data-scen="${p.key}"> <span>${p.label}</span></label>
          <p class="desc">${p.desc}</p>
          ${fixed ? "" : `<div class="ctl2"><input type="range" min="${p.min}" max="${p.max}" step="${p.step}" value="${p.default}" aria-label="${p.label}">
            <input type="number" min="${p.min}" max="${p.max}" step="${p.step}" value="${p.default}" aria-label="${p.label} value">
            <span class="unit">${p.unit}</span></div>`}
          <span class="badge" hidden></span>
        </div>`;
      }).join("")}
    </section>`;
  }).join("");
  $$(".sparam").forEach(el => {
    const key = el.dataset.key, cb = $("input[type=checkbox]", el);
    cb.addEventListener("change", () => setSel(key, cb.checked));
    const [rg, nm] = $$(".ctl2 input", el);
    if (rg) {
      rg.addEventListener("input", () => { nm.value = rg.value; scen.values[key] = Number(rg.value); });
      nm.addEventListener("change", () => { const p = scen.params.find(x => x.key === key); let v = Math.min(Math.max(Number(nm.value), p.min), p.max); nm.value = v; rg.value = v; scen.values[key] = v; });
    }
  });
  syncScenUI();
}

function setSel(key, on) {
  if (on) scen.sel[key] = true; else delete scen.sel[key];
  syncScenUI();
}

function syncScenUI() {
  $$(".sparam").forEach(el => {
    const key = el.dataset.key, on = !!scen.sel[key];
    el.classList.toggle("on", on);
    $("input[type=checkbox]", el).checked = on;
    const [rg, nm] = $$(".ctl2 input", el);
    if (rg) { rg.value = scen.values[key]; nm.value = scen.values[key]; }
  });
  ["positive", "negative", "neutral"].forEach(c => {
    const n = scen.params.filter(p => p.category === c && scen.sel[p.key]).length;
    $(`#cnt-${c}`).textContent = n ? `${n} ticked` : "";
  });
  updateRunLabel();
}

function selection() {
  return Object.fromEntries(Object.keys(scen.sel).map(k => [k, scen.values[k]]));
}

function updateRunLabel() {
  const n = Object.keys(scen.sel).length;
  const runs = 2 + ($("#scenPresets").checked ? 2 : 0) + ($("#scenImpacts").checked && n ? n : 0);
  $("#scenRun").textContent = `Run scenario (${runs} simulations)`;
}
["#scenPresets", "#scenImpacts"].forEach(id => $(id).addEventListener("change", updateRunLabel));

$$("[data-pick]").forEach(b => b.addEventListener("click", () => {
  const c = b.dataset.pick;
  if (c === "none") scen.sel = {};
  else scen.params.filter(p => p.category === c).forEach(p => { scen.sel[p.key] = true; });
  syncScenUI();
}));

function renderSaved() {
  $("#scenSaved").innerHTML = `<option value="">Saved scenarios…</option>` + scen.saved.map(s => `<option>${esc(s.name)}</option>`).join("");
}
function loadDefinition(def) {
  scen.sel = {};
  Object.entries(def.selection || {}).forEach(([k, v]) => {
    if (scen.params.some(p => p.key === k)) { scen.sel[k] = true; scen.values[k] = Number(v); }
  });
  if (def.name) $("#scenName").value = def.name;
  syncScenUI();
}
$("#scenSaved").addEventListener("change", e => {
  const s = scen.saved.find(x => x.name === e.target.value);
  if (s) { loadDefinition(s); $("#scenStatus").textContent = `Loaded “${s.name}”.`; }
});
$("#scenSave").addEventListener("click", async () => {
  try {
    const r = await api("/api/scenarios/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: $("#scenName").value, selection: selection() }) });
    scen.saved = r.saved; renderSaved(); $("#scenSaved").value = $("#scenName").value; $("#scenStatus").textContent = r.message;
  } catch (e) { $("#scenStatus").textContent = e.message; }
});
$("#scenDelete").addEventListener("click", async () => {
  const n = $("#scenSaved").value;
  if (!n) { $("#scenStatus").textContent = "Choose a saved scenario to delete."; return; }
  const r = await api("/api/scenarios/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: n }) });
  scen.saved = r.saved; renderSaved(); $("#scenStatus").textContent = r.message;
});
$("#scenExportDef").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ name: $("#scenName").value, selection: selection() }, null, 2)], { type: "application/json" });
  saveBlob(blob, `${$("#scenName").value.replace(/\W+/g, "_") || "scenario"}.json`);
});
$("#scenImport").addEventListener("change", async e => {
  const f = e.target.files[0]; if (!f) return;
  try { loadDefinition(JSON.parse(await f.text())); $("#scenStatus").textContent = `Loaded ${f.name}.`; }
  catch { $("#scenStatus").textContent = "That file is not a scenario definition (JSON with name and selection)."; }
  e.target.value = "";
});

$("#scenRun").addEventListener("click", async () => {
  const b = $("#scenRun");
  b.disabled = true;
  const n = b.textContent.match(/\d+/)?.[0];
  $("#scenStatus").textContent = `Running ${n} simulations with the sidebar settings as baseline…`;
  await paint();
  try {
    const r = await api("/api/scenarios/run", { onProgress: (i, t) => { $("#scenStatus").textContent = `Simulation ${i} of ${t} done…`; }, method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: state.settings, selection: selection(), name: $("#scenName").value,
        presets: $("#scenPresets").checked, impacts: $("#scenImpacts").checked, impact_mode: $("#scenImpactMode").value }) });
    scen.runId = r.run_id; scen.result = r.result;
    renderScenResult();
    $("#scenStatus").textContent = `Done. ${r.result.scenarios.length} scenarios${r.result.impacts.length ? ` and ${r.result.impacts.length} parameter impacts` : ""}.`;
  } catch (e) { $("#scenStatus").textContent = e.message; }
  finally { b.disabled = false; }
});
$$(".exp.sx").forEach(a => a.addEventListener("click", e => { e.preventDefault(); if (scen.runId) saveFromUrl(`/api/scenarios/export/${scen.runId}/${a.dataset.sfmt}`); }));
$$('input[name="scenMetric"]').forEach(r => r.addEventListener("change", renderScenChart));

function renderScenResult() {
  const R = scen.result;
  $("#scenResults").hidden = false;
  $("#scenTitle").textContent = `${R.name} compared with the baseline`;
  renderScenChart(); renderScenTable(); renderImpacts(); renderChanges();
  requestAnimationFrame(() => [scen.chart, scen.imp].forEach(c => c && c.resize()));
}

function renderScenChart() {
  const R = scen.result; if (!R) return;
  const m = $('input[name="scenMetric"]:checked').value;
  const base = R.scenarios[0], years = base.series.years, last = base.last_hist_year;
  const ds = [];
  ds.push({ label: "Observed", data: years.map((y, i) => y <= last ? base.series[m][i] : null), borderColor: "#2c5e4c", borderWidth: 2.6, pointRadius: 0 });
  R.scenarios.forEach(sc => {
    const col = SCEN_COL[sc.id] || "#666";
    if (sc.id === "custom" && m === "pensioners") {
      ds.push({ label: "_lo", data: sc.series.years.map((y, i) => y >= last ? (y === last ? sc.series.pensioners[i] : sc.series.lower[i]) : null), borderWidth: 0, pointRadius: 0, fill: false });
      ds.push({ label: "_hi", data: sc.series.years.map((y, i) => y >= last ? (y === last ? sc.series.pensioners[i] : sc.series.upper[i]) : null), borderWidth: 0, pointRadius: 0, fill: "-1", backgroundColor: "rgba(192,127,29,.14)" });
    }
    ds.push({ label: sc.name, data: sc.series.years.map((y, i) => y >= last ? sc.series[m][i] : null), borderColor: col, backgroundColor: col,
      borderWidth: sc.id === "custom" ? 3 : 1.8, borderDash: sc.id === "optimistic" || sc.id === "pessimistic" ? [6, 4] : [], pointRadius: 0 });
  });
  const pct = m === "share_65_plus", ra = m === "retirement_age", dep = m === "dependency";
  if (scen.chart) scen.chart.destroy();
  scen.chart = new Chart($("#scenChart"), {
    type: "line", data: { labels: years, datasets: ds },
    options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
      scales: { y: { ticks: { callback: v => pct ? `${v} %` : ra || dep ? v.toFixed(1) : `${millions(v)} M` } }, x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 14 } } },
      plugins: { legend: { position: "bottom", labels: { boxWidth: 14, boxHeight: 2, filter: i => !i.text.startsWith("_") } },
        tooltip: { filter: i => i.raw !== null && !i.dataset.label.startsWith("_"), callbacks: { label: c => `${c.dataset.label}: ${pct || ra || dep ? c.raw.toFixed(pct ? 1 : 2) : fmt(c.raw)}` } } } },
  });
}

function renderScenTable() {
  const R = scen.result, ys = R.milestone_years;
  const cell = (v, d, dec = 0, lowerIsBetter = true) => {
    if (d == null || Math.abs(d) < 1e-9) return `<td>${fmt(v, dec)}</td><td></td>`;
    const good = lowerIsBetter ? d < 0 : d > 0;
    return `<td>${fmt(v, dec)}</td><td class="${good ? "d-pos" : "d-neg"}">${d > 0 ? "+" : "–"}${fmt(Math.abs(d), dec)}</td>`;
  };
  let h = `<thead><tr><th>Scenario</th><th>Year</th><th>Recipients</th><th>vs baseline</th><th>Men</th><th>Women</th><th>Per 100 aged 15–64</th><th>vs baseline</th><th>Population</th><th>vs baseline</th><th>Ret. age</th></tr></thead><tbody>`;
  R.scenarios.forEach(sc => sc.milestones.forEach((m, i) => {
    h += `<tr class="${i === 0 ? "first" : ""}">${i === 0 ? `<td class="sname" rowspan="${sc.milestones.length}"><span class="cat" style="background:${SCEN_COL[sc.id]}"></span>${esc(sc.name)}</td>` : ""}<td>${m.year}</td>${cell(m.pensioners, sc.id === "baseline" ? null : m.pensioners_diff)}<td>${fmt(m.men)}</td><td>${fmt(m.women)}</td>${cell(m.dependency, sc.id === "baseline" ? null : m.dependency_diff, 1)}${cell(m.population, sc.id === "baseline" ? null : m.population_diff, 0, false)}<td>${fmt(m.retirement_age, 2)}</td></tr>`;
  }));
  $("#scenTable").innerHTML = h + "</tbody>";
}

function renderImpacts() {
  const R = scen.result, imp = R.impacts;
  $$(".sparam .badge").forEach(b => { b.hidden = true; });
  if (!imp.length) {
    $("#impNote").textContent = "Tick parameters and keep “Measure each ticked parameter's impact” on to see their contributions.";
    $("#impTable").innerHTML = ""; if (scen.imp) { scen.imp.destroy(); scen.imp = null; } $("#impWrap").style.height = "0"; return;
  }
  $("#impTitle").textContent = R.impact_mode === "within" ? "What each parameter contributes to your scenario" : "Each parameter on its own";
  $("#impNote").textContent = `Change in recipients per 100 aged 15–64 in ${R.impact_year}. ${R.metric_note}`;
  $("#impWrap").style.height = `${Math.max(140, imp.length * 34 + 50)}px`;
  if (scen.imp) scen.imp.destroy();
  scen.imp = new Chart($("#impChart"), {
    type: "bar",
    data: { labels: imp.map(i => i.label), datasets: [
      { label: `Change in ${R.impact_year}`, data: imp.map(i => i.d_dependency), backgroundColor: imp.map(i => CAT_COL[i.category]) },
      { label: "Average over the forecast", data: imp.map(i => i.d_dependency_avg), backgroundColor: imp.map(i => CAT_COL[i.category] + "66") },
    ] },
    options: { indexAxis: "y", responsive: true, maintainAspectRatio: false, animation: false,
      scales: { x: { title: { display: true, text: "← lowers burden    raises burden →", color: "#5d6b79" } }, y: { ticks: { font: { size: 11 } } } },
      plugins: { legend: { position: "bottom", labels: { boxWidth: 12 } }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.raw > 0 ? "+" : ""}${c.raw.toFixed(2)}` } } } },
  });
  $("#impTable").innerHTML = `<thead><tr><th>Parameter</th><th>Expected</th><th>Measured</th><th>Recipients ${R.impact_year}</th><th>Population ${R.impact_year}</th><th>Check</th></tr></thead><tbody>` +
    imp.map(i => `<tr><td><span class="cat ${i.category}"></span>${i.label}</td><td>${i.category}</td><td>${i.observed}</td><td>${i.d_pensioners > 0 ? "+" : ""}${fmt(i.d_pensioners)}</td><td>${i.d_population > 0 ? "+" : ""}${fmt(i.d_population)}</td><td>${i.status}</td></tr>`).join("") + "</tbody>";
  imp.forEach(i => {
    const b = $(`.sparam[data-key="${i.key}"] .badge`);
    if (!b) return;
    b.hidden = false;
    const d = Math.abs(i.d_dependency) >= Math.abs(i.d_dependency_avg) ? i.d_dependency : i.d_dependency_avg;
    b.textContent = i.no_effect ? "no effect in this combination" : `${d > 0 ? "+" : "–"}${Math.abs(d).toFixed(2)} burden, ${i.status}`;
    b.className = `badge ${i.status === "as expected" ? "ok" : "off"}`;
  });
}

function renderChanges() {
  const R = scen.result, cust = R.scenarios.find(s => s.id === "custom");
  $("#chgTable").innerHTML = cust && cust.changes.length
    ? `<thead><tr><th>Setting</th><th>Baseline</th><th>Your scenario</th></tr></thead><tbody>` + cust.changes.map(c => `<tr><td>${c.label}</td><td>${c.baseline}</td><td><b>${c.scenario}</b></td></tr>`).join("") + "</tbody>"
    : `<tbody><tr><td>No parameters ticked: your scenario equals the baseline.</td></tr></tbody>`;
  const w = [...new Set(R.scenarios.flatMap(s => s.warnings || []))];
  $("#scenWarn").innerHTML = w.length ? `<ul>${w.map(x => `<li>${x}</li>`).join("")}</ul>` : "";
}

initScenarios().catch(e => { $("#scenStatus").textContent = e.message; });
