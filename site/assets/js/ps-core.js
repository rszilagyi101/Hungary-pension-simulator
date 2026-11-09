/* Pension Simulator – core utilities and settings.
   Plain browser script; also loads in Node for testing (everything hangs off globalThis.PS). */
(function (G) {
  "use strict";
  const PS = (G.PS = G.PS || {});
  const D = G.PS_DEFAULTS;

  // ------------------------------------------------------------------ numbers
  const U = (PS.util = {});
  U.isNum = (v) => typeof v === "number" && Number.isFinite(v);
  U.nan = (v) => !(typeof v === "number" && Number.isFinite(v));
  U.sum = (a) => { let s = 0; for (const v of a) s += v; return s; };
  U.mean = (a) => U.sum(a) / a.length;
  U.std = (a, ddof = 0) => {
    const m = U.mean(a); let s = 0;
    for (const v of a) s += (v - m) * (v - m);
    return Math.sqrt(s / (a.length - ddof));
  };
  U.min = (a) => a.reduce((x, y) => (y < x ? y : x), Infinity);
  U.max = (a) => a.reduce((x, y) => (y > x ? y : x), -Infinity);
  U.clip = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  U.range = (a, b) => { const r = []; for (let i = a; i < b; i++) r.push(i); return r; };
  // numpy / Python round half to even
  U.roundHalfEven = (x, nd = 0) => {
    const f = Math.pow(10, nd), v = x * f, r = Math.round(v);
    const out = Math.abs(v % 1) === 0.5 ? (r % 2 === 0 ? r : r - 1) : r;
    return out / f;
  };
  // least-squares line y = a + b x  (np.polyfit(x, y, 1) -> [b, a])
  U.polyfit1 = (xs, ys) => {
    const n = xs.length, mx = U.mean(xs), my = U.mean(ys);
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
    const b = sxx === 0 ? 0 : sxy / sxx;
    return { b, a: my - b * mx };
  };
  // linear interpolation of NaN gaps by position. mode: "inside" (only between values) or "both"
  // ("both" also fills the ends with the nearest value, like pandas limit_direction="both").
  U.interpolate = (arr, mode = "inside", xs = null) => {
    const out = arr.slice(), idx = [];
    arr.forEach((v, i) => { if (U.isNum(v)) idx.push(i); });
    if (idx.length === 0) return out;
    const X = xs || arr.map((_, i) => i);
    for (let i = 0; i < arr.length; i++) {
      if (U.isNum(arr[i])) continue;
      let lo = -1, hi = -1;
      for (const j of idx) { if (j < i) lo = j; else if (j > i) { hi = j; break; } }
      if (lo >= 0 && hi >= 0) out[i] = arr[lo] + (arr[hi] - arr[lo]) * (X[i] - X[lo]) / (X[hi] - X[lo]);
      else if (mode === "both") out[i] = arr[lo >= 0 ? lo : hi];
    }
    return out;
  };
  U.ffill = (arr) => { const out = arr.slice(); let last = NaN; for (let i = 0; i < out.length; i++) { if (U.isNum(out[i])) last = out[i]; else if (U.isNum(last)) out[i] = last; } return out; };

  // inverse standard normal CDF (Acklam), |error| < 1.2e-9
  U.normPpf = (p) => {
    const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
    const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
    const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
    const pl = 0.02425;
    let q, r, x;
    if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    else if (p <= 1 - pl) { q = p - 0.5; r = q * q; x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
    else { q = Math.sqrt(-2 * Math.log(1 - p)); x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    // one Newton step with erfc for full precision
    const e = 0.5 * U.erfc(-x / Math.SQRT2) - p;
    const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
    return x - u / (1 + (x * u) / 2);
  };
  U.erfc = (x) => { // Numerical Recipes erfc, relative error < 1.2e-7
    const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
    const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? r : 2 - r;
  };

  // seeded random numbers (mulberry32)
  U.rng = (seed) => {
    let a = (seed >>> 0) || 0x9e3779b9;
    return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  };

  // Nelder–Mead minimisation
  U.nelderMead = (f, x0, { maxIter = 2000, tol = 1e-10, step = 0.1 } = {}) => {
    const n = x0.length;
    let simplex = [x0.slice()];
    for (let i = 0; i < n; i++) { const x = x0.slice(); x[i] = x[i] !== 0 ? x[i] * (1 + step) + step * 0.05 : step; simplex.push(x); }
    let fv = simplex.map((x) => { const v = f(x); return Number.isFinite(v) ? v : 1e300; });
    const F = (x) => { const v = f(x); return Number.isFinite(v) ? v : 1e300; };
    for (let it = 0; it < maxIter; it++) {
      const ord = fv.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
      simplex = ord.map((i) => simplex[i]); fv = ord.map((i) => fv[i]);
      if (Math.abs(fv[n] - fv[0]) <= tol * (Math.abs(fv[0]) + tol) && it > 20) break;
      const c = new Array(n).fill(0);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += simplex[i][j] / n;
      const xr = c.map((v, j) => v + (v - simplex[n][j])), fr = F(xr);
      if (fr < fv[0]) {
        const xe = c.map((v, j) => v + 2 * (v - simplex[n][j])), fe = F(xe);
        if (fe < fr) { simplex[n] = xe; fv[n] = fe; } else { simplex[n] = xr; fv[n] = fr; }
      } else if (fr < fv[n - 1]) { simplex[n] = xr; fv[n] = fr; }
      else {
        const outside = fr < fv[n];
        const xc = outside ? c.map((v, j) => v + 0.5 * (xr[j] - v)) : c.map((v, j) => v + 0.5 * (simplex[n][j] - v));
        const fc = F(xc);
        if (fc < (outside ? fr : fv[n])) { simplex[n] = xc; fv[n] = fc; }
        else for (let i = 1; i <= n; i++) { simplex[i] = simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j])); fv[i] = F(simplex[i]); }
      }
    }
    let best = 0; for (let i = 1; i <= n; i++) if (fv[i] < fv[best]) best = i;
    return { x: simplex[best], f: fv[best] };
  };

  // solve A x = b (Gaussian elimination, partial pivoting); A is n×n array of arrays
  U.solve = (A, b) => {
    const n = b.length, M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-300) throw new Error("singular matrix");
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
    return x;
  };

  // ------------------------------------------------------------------ formatting
  U.fmt = (v, nd = 0) => (v === null || v === undefined || !Number.isFinite(Number(v)) || v === "") ? "" :
    Number(v).toLocaleString("en-US", { minimumFractionDigits: nd, maximumFractionDigits: nd });
  U.signed = (v, nd = 0) => (U.nan(v) ? "" : (v > 0 ? "+" : v < 0 ? "-" : "") + U.fmt(Math.abs(v), nd));
  U.stamp = () => { const d = new Date(), p = (x) => String(x).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; };
  U.nowText = () => { const d = new Date(), p = (x) => String(x).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  U.clone = (o) => JSON.parse(JSON.stringify(o));

  // ------------------------------------------------------------------ settings
  const S = (PS.settings = {});
  S.SPEC = D.spec;
  S.BY_KEY = Object.fromEntries(D.spec.map((s) => [s.key, s]));
  S.MODEL_KEYS = D.modelKeys;
  S.MODEL_LABELS = D.modelLabels;
  S.defaults = () => Object.fromEntries(D.spec.map((s) => [s.key, s.default]));

  function coerce(spec, value) {
    const t = spec.type;
    if (value === null || value === undefined || value === "") return spec.default;
    if (t === "bool") {
      if (typeof value === "string") return ["1", "true", "yes", "on", "igen"].includes(value.trim().toLowerCase());
      return Boolean(value);
    }
    if (t === "select") {
      const allowed = spec.options.map((o) => o[0]);
      const v = typeof value === "number" && Number.isInteger(value) ? String(value) : String(value);
      return allowed.includes(v) ? v : spec.default;
    }
    const num = typeof value === "boolean" ? Number(value) : Number(value);
    if (!Number.isFinite(num)) return spec.default;
    const c = Math.min(Math.max(num, spec.min), spec.max);
    return t === "int" ? U.roundHalfEven(c) : c;
  }
  S.validate = (raw) => {
    raw = raw || {};
    const s = {};
    for (const spec of D.spec) s[spec.key] = coerce(spec, Object.prototype.hasOwnProperty.call(raw, spec.key) ? raw[spec.key] : spec.default);
    if (s.ret_age_end <= s.ret_age_start) s.ret_age_end = s.ret_age_start + 1;
    if (s.target === "oldage_pensioners") s.start_year = Math.max(s.start_year, 2000);
    return s;
  };
  S.toRows = (s) => D.spec.map((spec) => ({ group: spec.group, key: spec.key, label: spec.label, value: Object.prototype.hasOwnProperty.call(s, spec.key) ? s[spec.key] : spec.default }));
  S.fromTable = (rows) => {
    const raw = {};
    for (const r of rows) { const k = String(r.key ?? "").trim(); if (S.BY_KEY[k]) raw[k] = r.value; }
    return S.validate(raw);
  };
  S.fromJsonText = (text) => {
    let data = JSON.parse(text);
    if (data && typeof data === "object" && "settings" in data) data = data.settings;
    return S.validate(data);
  };

  // ------------------------------------------------------------------ CSV helpers
  const C = (PS.csv = {});
  C.cell = (v) => {
    if (v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v))) return "";
    if (typeof v === "boolean") return v ? "True" : "False";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // rows: array of objects; cols: column order (defaults to keys of the first row)
  C.write = (rows, cols) => {
    cols = cols || (rows.length ? Object.keys(rows[0]) : []);
    const out = [cols.map(C.cell).join(",")];
    for (const r of rows) out.push(cols.map((c) => C.cell(r[c])).join(","));
    return out.join("\n") + "\n";
  };
  // parse delimited text; handles quotes. Returns array of arrays.
  C.parse = (text, sep) => {
    const rows = []; let row = [], cur = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === sep) { row.push(cur); cur = ""; }
      else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
      else cur += ch;
    }
    if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
    return rows.filter((r) => r.some((c) => c.trim() !== ""));
  };
})(globalThis);
