/* Pension Simulator – forecasting engine (port of core/models.py).
   Every model: forecast(train, fut, target, s) -> {mean, lo, hi}
   train / fut are arrays of row objects ({year, column: value}). */
(function (G) {
  "use strict";
  const PS = G.PS, U = PS.util, DATA = PS.data, POP = PS.population, SET = PS.settings;
  const M = (PS.models = {});
  const MILESTONES = [2030, 2040, 2050, 2060, 2070];
  const col = (frame, c) => frame.map((r) => r[c]);
  const NANROW = () => Object.fromEntries(DATA.COLUMNS.map((c) => [c, NaN]));

  // ------------------------------------------------------------------ scenario inputs (build_frames)
  M.buildFrames = (ds, s, pop) => {
    const notes = [], target = s.target, T = ds.T, P = ds.P;
    const tYears = ds.years.filter((y) => U.isNum(T.get(y)[target]));
    const last = U.max(tYears), first = Math.max(s.start_year, U.min(tYears));
    let hist = ds.years.filter((y) => y >= first && y <= last).map((y) => ({ year: y, ...T.get(y) }));
    if (hist.some((r) => U.nan(r[target]))) {
      const filled = U.interpolate(col(hist, target), "inside");
      hist.forEach((r, i) => { r[target] = filled[i]; });
    }
    hist = hist.filter((r) => U.isNum(r[target]));
    const futYears = U.range(last + 1, s.end_year + 1);
    const fut = futYears.map((y) => ({ year: y, ...(T.has(y) ? T.get(y) : NANROW()) }));

    let source = s.population_source || "ccm";
    if (source === "eurostat" && !ds.hasAgeDetail) {
      notes.push("Eurostat projection not downloaded yet – using the cohort-component projection instead.");
      source = "ccm";
    }
    const useCcm = source === "ccm" && !!pop;
    if (useCcm) {
      const rows = new Map(pop.rows.filter((r) => r.type === "projection").map((r) => [r.year, r]));
      for (const r of fut) {
        const pr = rows.get(r.year);
        if (!pr) continue;
        const prov = P.get(r.year) || {};
        if (prov.population !== "user") r.population = pr.total;
        if (prov.pop_65plus !== "user") r.pop_65plus = pr.age_65_plus;
        r.share_65plus = (r.pop_65plus / r.population) * 100;
      }
    }
    for (const c of ["population", "share_65plus", "pop_65plus"]) {
      const v = col(fut, c);
      if (v.some(U.nan)) {
        let f = U.interpolate(v, "both");
        if (f.every(U.nan)) { f = f.map(() => hist[hist.length - 1][c]); notes.push(`No projection for ${c}; held constant at last observed value.`); }
        fut.forEach((r, i) => { r[c] = f[i]; });
      }
    }
    const adj = 1 + s.elderly_pop_adj_pct / 100;
    if (adj !== 1) fut.forEach((r) => { r.pop_65plus *= adj; r.share_65plus = (r.pop_65plus / r.population) * 100; });

    // life expectancy: last observed + scenario gain
    const leYears = hist.filter((r) => U.isNum(r.life_expectancy));
    const leLastYear = leYears[leYears.length - 1].year, leLast = leYears[leYears.length - 1].life_expectancy;
    fut.forEach((r) => {
      const user = r.life_expectancy;
      r.life_expectancy = U.isNum(user) ? user : leLast + (s.le_gain_decade / 10) * (r.year - leLastYear);
    });
    const leF = U.ffill(col(hist, "life_expectancy")); hist.forEach((r, i) => { r.life_expectancy = leF[i]; });

    // retirement age path
    const raHist = hist.filter((r) => U.isNum(r.retirement_age));
    const raLast = raHist[raHist.length - 1].retirement_age;
    let userRa = false;
    fut.forEach((r) => {
      const user = r.retirement_age;
      let ra;
      if (r.year < s.ret_age_start) ra = raLast;
      else if (r.year >= s.ret_age_end) ra = s.ret_age_target;
      else ra = raLast + ((s.ret_age_target - raLast) * (r.year - s.ret_age_start + 1)) / (s.ret_age_end - s.ret_age_start + 1);
      if (s.link_ret_age_le) ra += s.le_link_share * Math.max(0, r.life_expectancy - leLast);
      r.retirement_age = Math.min(ra, 72);
      if (U.isNum(user)) { r.retirement_age = user; userRa = true; }
    });
    if (userRa) notes.push("User-supplied future retirement ages override the scenario path.");

    // population at/above the retirement age of each year
    hist.forEach((r) => { r.pop_ret_age = NaN; }); fut.forEach((r) => { r.pop_ret_age = NaN; });
    if (pop) {
      const at = pop.ages_total;
      hist.forEach((r) => { if (at.has(r.year)) r.pop_ret_age = POP.popAtOrAbove(at.get(r.year), r.retirement_age); });
      if (useCcm) fut.forEach((r) => { if (at.has(r.year)) r.pop_ret_age = POP.popAtOrAbove(at.get(r.year), r.retirement_age); });
    }
    if (source === "eurostat") {
      const ap = ds.agesProj;
      fut.forEach((r) => { if (ap && ap[r.year]) r.pop_ret_age = POP.popAtOrAbove(ap[r.year], r.retirement_age); });
      const lh = hist[hist.length - 1];
      if (ap && ap[lh.year] && U.isNum(lh.pop_ret_age)) {
        const ref = POP.popAtOrAbove(ap[lh.year], lh.retirement_age);
        fut.forEach((r) => { r.pop_ret_age *= lh.pop_ret_age / ref; });
      }
    }
    if (s.elderly_pop_adj_pct) fut.forEach((r) => { r.pop_ret_age *= adj; });
    const pra = col(hist, "pop_ret_age");
    if (pra.some(U.nan) && pra.some(U.isNum)) { const f = U.interpolate(pra, "both"); hist.forEach((r, i) => { r.pop_ret_age = f[i]; }); }

    for (const frame of [hist, fut]) frame.forEach((r) => {
      r.pop65_m = r.pop_65plus / 1e6;
      r.break2012 = s.break_dummy_2012 ? (r.year >= 2012 ? 1 : 0) : 0;
      r.t = r.year - 1990;
    });
    return { hist, fut, notes, source };
  };

  // ------------------------------------------------------------------ helpers
  const zOf = (s) => U.normPpf(0.5 + Number(s.conf_level) / 2);
  const band = (mean, sigma, z, grow = "sqrt") => {
    const lo = [], hi = [];
    mean.forEach((m, i) => { const h = i + 1, w = sigma * (grow === "sqrt" ? Math.sqrt(h) : h); lo.push(m * Math.exp(-z * w)); hi.push(m * Math.exp(z * w)); });
    return { lo, hi };
  };
  const exogCols = (train, s) => {
    const cols = ["pop_65plus", "retirement_age"];
    if (s.break_dummy_2012 && new Set(col(train, "break2012")).size > 1) cols.push("break2012");
    return cols.filter((c) => { const v = col(train, c); return v.every(U.isNum) && U.std(v, 1) > 0; });
  };
  const eligible = (frame) => (frame.every((r) => U.isNum(r.pop_ret_age)) ? { den: col(frame, "pop_ret_age"), exact: true } : { den: col(frame, "pop_65plus"), exact: false });

  // ------------------------------------------------------------------ ARIMA / ARIMAX (exact likelihood, Kalman filter)
  const diff = (a, d) => { let x = a.slice(); for (let k = 0; k < d; k++) x = x.slice(1).map((v, i) => v - x[i]); return x; };
  // partial autocorrelations (via tanh) -> stationary AR coefficients (Durbin–Levinson)
  const constrainAR = (u) => {
    const p = u.length; if (!p) return [];
    const r = u.map((v) => Math.tanh(v));
    let phi = [];
    for (let k = 0; k < p; k++) { const nw = []; for (let j = 0; j < k; j++) nw.push(phi[j] - r[k] * phi[k - 1 - j]); nw.push(r[k]); phi = nw; }
    return phi;
  };
  const armaSystem = (phi, theta) => {
    const p = phi.length, q = theta.length, r = Math.max(p, q + 1);
    const T = Array.from({ length: r }, (_, i) => Array.from({ length: r }, (_, j) => (j === 0 ? (phi[i] || 0) : j === i + 1 ? 1 : 0)));
    const R = Array.from({ length: r }, (_, i) => (i === 0 ? 1 : theta[i - 1] || 0));
    // initial covariance: P = T P T' + R R'  ->  (I - T⊗T) vec P = vec(RR')
    const n2 = r * r, A = [], b = [];
    for (let i = 0; i < r; i++) for (let j = 0; j < r; j++) {
      const row = new Array(n2).fill(0);
      row[i * r + j] += 1;
      for (let k = 0; k < r; k++) for (let l = 0; l < r; l++) row[k * r + l] -= T[i][k] * T[j][l];
      A.push(row); b.push(R[i] * R[j]);
    }
    const v = U.solve(A, b), P0 = Array.from({ length: r }, (_, i) => v.slice(i * r, i * r + r));
    return { r, T, R, P0 };
  };
  // Kalman filter for several series sharing one ARMA system (observation = first state, no noise)
  const kalman = (sys, series) => {
    const { r, T, R } = sys;
    let P = sys.P0.map((x) => x.slice());
    const a = series.map(() => new Array(r).fill(0));
    const n = series[0].length, std = series.map(() => new Array(n)), logF = [];
    for (let t = 0; t < n; t++) {
      const F = P[0][0];
      if (!(F > 0)) throw new Error("non-positive variance");
      logF.push(Math.log(F));
      const Pc = P.map((row) => row[0]);
      for (let j = 0; j < series.length; j++) {
        const v = series[j][t] - a[j][0];
        std[j][t] = v / Math.sqrt(F);
        const upd = a[j].map((x, i) => x + (Pc[i] * v) / F);
        a[j] = T.map((row) => row.reduce((s2, tv, k) => s2 + tv * upd[k], 0));
      }
      const Pu = P.map((row, i) => row.map((x, k) => x - (Pc[i] * Pc[k]) / F));
      const TP = T.map((row) => P[0].map((_, k) => row.reduce((s2, tv, m) => s2 + tv * Pu[m][k], 0)));
      P = TP.map((row, i) => T.map((trow, j) => row.reduce((s2, v, m) => s2 + v * trow[m], 0) + R[i] * R[j]));
    }
    return { std, logF, a };
  };
  // stationary AR coefficients -> unconstrained parameters (inverse of constrainAR)
  const unconstrainAR = (phi) => {
    let cur = phi.slice(); const r = new Array(phi.length);
    for (let k = phi.length; k >= 1; k--) {
      const rk = U.clip(cur[k - 1], -0.98, 0.98); r[k - 1] = rk;
      const prev = []; for (let j = 0; j < k - 1; j++) prev.push((cur[j] + rk * cur[k - 2 - j]) / (1 - rk * rk));
      cur = prev;
    }
    return r.map((v) => Math.atanh(U.clip(v, -0.98, 0.98)));
  };
  const ols = (X, y) => {
    const k = X[0].length;
    const A = U.range(0, k).map((i) => U.range(0, k).map((j) => X.reduce((s2, r) => s2 + r[i] * r[j], 0) + (i === j ? 1e-10 : 0)));
    const b = U.range(0, k).map((i) => X.reduce((s2, r, t) => s2 + r[i] * y[t], 0));
    return U.solve(A, b);
  };
  const hannanRissanen = (w, Rg, p, q) => {
    try {
      let e = w.slice();
      if (Rg.length && Rg[0].length) { const b = ols(Rg, w); e = w.map((v, t) => v - Rg[t].reduce((s2, x, j) => s2 + x * b[j], 0)); }
      const n = e.length;
      let eps = new Array(n).fill(0);
      if (q > 0) {   // long autoregression for the innovations
        const m = Math.min(Math.max(Math.floor(Math.log(n) ** 2), 2 * Math.max(p, q)), Math.floor(n / 3));
        const rows = [], ys = [];
        for (let t = m; t < n; t++) { rows.push(U.range(1, m + 1).map((l) => e[t - l])); ys.push(e[t]); }
        const a = ols(rows, ys);
        eps = e.map((v, t) => (t < m ? 0 : v - a.reduce((s2, c, l) => s2 + c * e[t - l - 1], 0)));
      }
      const st = Math.max(p, q) + (q > 0 ? Math.min(Math.max(Math.floor(Math.log(n) ** 2), 2 * Math.max(p, q)), Math.floor(n / 3)) : 0);
      const rows = [], ys = [];
      for (let t = st; t < n; t++) { rows.push([...U.range(1, p + 1).map((l) => e[t - l]), ...U.range(1, q + 1).map((l) => eps[t - l])]); ys.push(e[t]); }
      const c = ols(rows, ys);
      return [...unconstrainAR(c.slice(0, p)), ...unconstrainAR(c.slice(p).map((v) => -v))];
    } catch (err) { return new Array(p + q).fill(0); }
  };
  const armaFit = (w, Rg, p, q) => {
    const k = Rg.length ? Rg[0].length : 0, n = w.length;
    const regCols = U.range(0, k).map((j) => Rg.map((row) => row[j]));
    const evaluate = (u) => {
      const phi = constrainAR(u.slice(0, p)), theta = constrainAR(u.slice(p)).map((v) => -v);
      const sys = armaSystem(phi, theta);
      const kf = kalman(sys, [w, ...regCols]);
      // GLS for the regression coefficients on the standardised innovations
      let beta = [];
      if (k) {
        const Xs = U.range(0, n).map((t) => regCols.map((_, j) => kf.std[j + 1][t]));
        const XtX = U.range(0, k).map((i) => U.range(0, k).map((j) => Xs.reduce((s2, row) => s2 + row[i] * row[j], 0)));
        const Xty = U.range(0, k).map((i) => Xs.reduce((s2, row, t) => s2 + row[i] * kf.std[0][t], 0));
        beta = U.solve(XtX, Xty);
      }
      let ss = 0;
      for (let t = 0; t < n; t++) { let e = kf.std[0][t]; for (let j = 0; j < k; j++) e -= beta[j] * kf.std[j + 1][t]; ss += e * e; }
      const sigma2 = ss / n;
      const nll = 0.5 * (n * Math.log(2 * Math.PI * sigma2) + U.sum(kf.logF) + n);
      return { nll, phi, theta, beta, sigma2, sys };
    };
    let best = { x: new Array(p + q).fill(0) };
    if (p + q > 0) {
      const f = (u) => { try { return evaluate(u).nll; } catch (e) { return Infinity; } };
      // start from Hannan–Rissanen estimates, as statsmodels does, so both versions reach the same optimum
      const x0 = hannanRissanen(w, Rg, p, q);
      let r1 = U.nelderMead(f, x0, { maxIter: 3000, step: 0.1 });
      for (let rep = 0; rep < 2; rep++) r1 = U.nelderMead(f, r1.x, { maxIter: 3000, step: 0.05 });
      best = r1;
    }
    return evaluate(best.x);
  };
  const arimaOnce = (y, X, Xf, p, d, q, H) => {
    const w = diff(y, d), n = w.length;
    const useConst = d < 2;
    const Xall = X ? X.concat(Xf) : null;
    const k = X ? X[0].length : 0;
    const dX = X ? U.range(0, k).map((j) => diff(Xall.map((r) => r[j]), d)) : [];
    const reg = (t) => [...dX.map((c) => c[t]), ...(useConst ? [1] : [])];   // t indexes the differenced series
    const Rg = U.range(0, n).map((t) => reg(t));
    const fit = armaFit(w, Rg[0] && Rg[0].length ? Rg : [], p, q);
    const beta = fit.beta;
    const resid = w.map((v, t) => v - Rg[t].reduce((s2, x, j) => s2 + x * (beta[j] || 0), 0));
    const kf = kalman(fit.sys, [resid]);
    let a = kf.a[0];
    const wf = [];
    for (let h = 0; h < H; h++) {
      const rg = reg(n + h);
      wf.push(rg.reduce((s2, x, j) => s2 + x * (beta[j] || 0), 0) + a[0]);
      a = fit.sys.T.map((row) => row.reduce((s2, tv, m) => s2 + tv * a[m], 0));
    }
    // integrate back to levels
    let cur = wf;
    for (let kk = d - 1; kk >= 0; kk--) { const lv = diff(y, kk); let acc = lv[lv.length - 1]; cur = cur.map((v) => (acc += v)); }
    // forecast variance from psi weights of the integrated model
    const psi = [1];
    for (let j = 1; j < H; j++) {
      let v = j <= fit.theta.length ? fit.theta[j - 1] : 0;
      for (let i = 1; i <= Math.min(j, fit.phi.length); i++) v += fit.phi[i - 1] * psi[j - i];
      psi.push(v);
    }
    let ps = psi; for (let kk = 0; kk < d; kk++) { let acc = 0; ps = ps.map((v) => (acc += v)); }
    let cumv = 0; const se = ps.map((v) => { cumv += v * v; return Math.sqrt(fit.sigma2 * cumv); });
    return { mean: cur, se };
  };
  M._arima = { diff, armaFit, arimaOnce, constrainAR, unconstrainAR, armaSystem, kalman };   // exposed for tests
  M.fArima = (train, fut, target, s) => {
    const y0 = col(train, target), y = s.arima_log ? y0.map(Math.log) : y0;
    const { arima_p: p, arima_d: d, arima_q: q } = s;
    let X = null, Xf = null;
    if (s.arima_exog) {
      const cols = exogCols(train, s);
      if (cols.length) {
        const mu = cols.map((c) => U.mean(col(train, c))), sd = cols.map((c) => U.std(col(train, c), 1) || 1);
        X = train.map((r) => cols.map((c, j) => (r[c] - mu[j]) / sd[j]));
        Xf = fut.map((r) => cols.map((c, j) => (r[c] - mu[j]) / sd[j]));
      }
    }
    const z = zOf(s);
    let lastErr = null;
    for (const [pp, dd, qq] of [[p, d, q], [1, d, 0], [0, d, 0]]) {
      try {
        const fc = arimaOnce(y, X, Xf, pp, dd, qq, fut.length);
        if (!fc.mean.every(Number.isFinite)) throw new Error("non-finite forecast");
        const lo = fc.mean.map((m, i) => m - z * fc.se[i]), hi = fc.mean.map((m, i) => m + z * fc.se[i]);
        if (s.arima_log) return { mean: fc.mean.map(Math.exp), lo: lo.map(Math.exp), hi: hi.map(Math.exp) };
        return { mean: fc.mean, lo, hi };
      } catch (e) { lastErr = e; }
    }
    throw new Error(`ARIMA failed: ${lastErr && lastErr.message}`);
  };

  // ------------------------------------------------------------------ Holt exponential smoothing
  const holtRun = (y, alpha, beta, phi, l0, b0) => {
    let l = l0, b = b0; const fitted = [];
    for (const v of y) {
      const yhat = l + phi * b; fitted.push(yhat);
      const ln = alpha * v + (1 - alpha) * (l + phi * b);
      b = beta * (ln - l) + (1 - beta) * phi * b; l = ln;
    }
    return { fitted, l, b };
  };
  const sigm = (u) => 1 / (1 + Math.exp(-u));
  M.fEts = (train, fut, target, s) => {
    const y0 = col(train, target), y = s.ets_log ? y0.map(Math.log) : y0;
    const phi = s.ets_damped ? s.ets_phi : 1;
    // for given smoothing parameters the errors are affine in (l0, b0): solve those by least squares
    const fitInit = (alpha, beta) => {
      const e = (l0, b0) => holtRun(y, alpha, beta, phi, l0, b0).fitted.map((f, i) => y[i] - f);
      const e0 = e(0, 0), e1 = e(1, 0), e2 = e(0, 1);
      const A = e1.map((v, i) => e0[i] - v), B = e2.map((v, i) => e0[i] - v);   // e = e0 - l0*A - b0*B
      const sAA = U.sum(A.map((v) => v * v)), sBB = U.sum(B.map((v) => v * v)), sAB = U.sum(A.map((v, i) => v * B[i]));
      const sAe = U.sum(A.map((v, i) => v * e0[i])), sBe = U.sum(B.map((v, i) => v * e0[i]));
      const [l0, b0] = U.solve([[sAA, sAB], [sAB, sBB]], [sAe, sBe]);
      const err = e0.map((v, i) => v - l0 * A[i] - b0 * B[i]);
      return { l0, b0, sse: U.sum(err.map((v) => v * v)) };
    };
    const obj = (u) => { try { return fitInit(sigm(u[0]), sigm(u[0]) * sigm(u[1])).sse; } catch (e) { return Infinity; } };
    let best = null;
    for (const a0 of [-1.5, 0, 1.5, 3]) for (const b0 of [-2, 0, 2]) {
      const r = U.nelderMead(obj, [a0, b0], { maxIter: 600, step: 0.5 });
      if (!best || r.f < best.f) best = r;
    }
    best = U.nelderMead(obj, best.x, { maxIter: 1500, step: 0.1 });
    const alpha = sigm(best.x[0]), beta = alpha * sigm(best.x[1]);
    const init = fitInit(alpha, beta), run = holtRun(y, alpha, beta, phi, init.l0, init.b0);
    let mean = []; let acc = 0;
    for (let h = 1; h <= fut.length; h++) { acc += Math.pow(phi, h); mean.push(run.l + acc * run.b); }
    const resid = run.fitted.map((f, i) => y[i] - f).slice(2);
    let sigma;
    if (s.ets_log) { mean = mean.map(Math.exp); sigma = U.std(resid); }
    else sigma = U.std(resid.map((r, i) => r / y[i + 2]));
    const b = band(mean, sigma, zOf(s), s.ets_damped ? "sqrt" : "lin");
    return { mean, lo: b.lo, hi: b.hi };
  };

  // ------------------------------------------------------------------ demographic ratio model
  M.fStructural = (train, fut, target, s) => {
    let et = eligible(train), ef = eligible(fut);
    let exact = et.exact;
    if (et.exact !== ef.exact) { et = { den: col(train, "pop_65plus") }; ef = { den: col(fut, "pop_65plus") }; exact = false; }
    const ratio = train.map((r, i) => r[target] / et.den[i]);
    const w = Math.min(s.ratio_window, ratio.length), rr = ratio.slice(-w), xs = U.range(0, w);
    const { a, b } = U.polyfit1(xs, rr);
    const resid = rr.map((v, i) => v - (a + b * i));
    const phi = s.ratio_phi, last = rr[rr.length - 1];
    const rmin = U.min(ratio) * 0.5, rmax = U.max(ratio) * 1.5;
    let mean = fut.map((r, i) => {
      const h = i + 1; let damp = 0; for (let k = 1; k <= h; k++) damp += Math.pow(phi, k);
      const rf = U.clip((last + b * damp) * Math.pow(1 + s.ratio_drift_pct / 100, h), rmin, rmax);
      return rf * ef.den[i];
    });
    if (!exact) {
      const ra0 = train[train.length - 1].retirement_age;
      mean = mean.map((m, i) => m * U.clip(1 - (s.ret_age_elasticity / 100) * (fut[i].retirement_age - ra0), 0.3, 1.5));
    }
    const sigma = U.std(resid) / Math.max(Math.abs(last), 1e-9) + 0.004;
    const bd = band(mean, sigma, zOf(s));
    return { mean, lo: bd.lo, hi: bd.hi };
  };

  // ------------------------------------------------------------------ machine learning
  const FEATURES = ["retirement_age", "pop65_m", "life_expectancy", "break2012", "t"];
  // regression tree (CART, squared error)
  const buildTree = (X, y, idx, depth, o, rng) => {
    const n = idx.length; let sum = 0; for (const i of idx) sum += y[i];
    const value = sum / n;
    let sse = 0; for (const i of idx) sse += (y[i] - value) ** 2;
    if (depth >= o.maxDepth || n < o.minSplit || n < 2 * o.minLeaf || sse <= 1e-14 * Math.max(1, n)) return { value };
    const nf = X[0].length, feats = U.range(0, nf);
    for (let i = nf - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [feats[i], feats[j]] = [feats[j], feats[i]]; }
    let best = null;
    for (const f of feats) {
      const ord = idx.slice().sort((p, q) => X[p][f] - X[q][f]);
      let sl = 0;
      for (let k = 1; k < n; k++) {
        sl += y[ord[k - 1]];
        if (k < o.minLeaf || n - k < o.minLeaf) continue;
        const xa = X[ord[k - 1]][f], xb = X[ord[k]][f];
        if (xb <= xa) continue;
        const sr = sum - sl, gain = (sl * sl) / k + (sr * sr) / (n - k);
        if (!best || gain > best.gain + 1e-12) best = { gain, f, thr: (xa + xb) / 2, k, ord };
      }
    }
    if (!best || best.gain - (sum * sum) / n <= 1e-12) return { value };
    const L = [], R = [];
    for (const i of idx) (X[i][best.f] <= best.thr ? L : R).push(i);
    if (!L.length || !R.length) return { value };
    return { f: best.f, thr: best.thr, left: buildTree(X, y, L, depth + 1, o, rng), right: buildTree(X, y, R, depth + 1, o, rng) };
  };
  const treePredict = (node, x) => { while (node.left) node = x[node.f] <= node.thr ? node.left : node.right; return node.value; };
  const scaler = (X) => {
    const nf = X[0].length, mu = [], sd = [];
    for (let j = 0; j < nf; j++) { const c = X.map((r) => r[j]); mu.push(U.mean(c)); const v = U.std(c); sd.push(v > 0 ? v : 1); }
    return { tf: (x) => x.map((v, j) => (v - mu[j]) / sd[j]) };
  };
  const MODELS = {
    rf(X, y, s) {
      const rng = U.rng(s.random_seed + 1), n = X.length, trees = [];
      const o = { maxDepth: s.rf_depth, minLeaf: 2, minSplit: 2 };
      for (let t = 0; t < s.rf_trees; t++) {
        const idx = U.range(0, n).map(() => Math.floor(rng() * n));
        trees.push(buildTree(X, y, idx, 0, o, rng));
      }
      return { predict: (x) => U.mean(trees.map((tr) => treePredict(tr, x))) };
    },
    gb(X, y, s) {
      const rng = U.rng(s.random_seed + 2), n = X.length, lr = s.gb_lr, f0 = U.mean(y), trees = [];
      const F = new Array(n).fill(f0), nIn = Math.max(1, Math.floor(0.9 * n));
      const o = { maxDepth: s.gb_depth, minLeaf: 1, minSplit: 2 };
      for (let m = 0; m < s.gb_trees; m++) {
        const perm = U.range(0, n); for (let i = n - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
        const inb = perm.slice(0, nIn), r = y.map((v, i) => v - F[i]);
        const tr = buildTree(X, r, inb, 0, o, rng);
        trees.push(tr);
        for (let i = 0; i < n; i++) F[i] += lr * treePredict(tr, X[i]);
      }
      return { predict: (x) => f0 + lr * U.sum(trees.map((tr) => treePredict(tr, x))) };
    },
    ridge(X, y, s) {
      const sc = scaler(X), Z = X.map(sc.tf), k = Z[0].length, ym = U.mean(y);
      const zm = U.range(0, k).map((j) => U.mean(Z.map((r) => r[j])));
      const A = U.range(0, k).map((i) => U.range(0, k).map((j) => Z.reduce((s2, r) => s2 + (r[i] - zm[i]) * (r[j] - zm[j]), 0) + (i === j ? s.ridge_alpha : 0)));
      const b = U.range(0, k).map((i) => Z.reduce((s2, r, t) => s2 + (r[i] - zm[i]) * (y[t] - ym), 0));
      const w = U.solve(A, b), b0 = ym - zm.reduce((s2, v, j) => s2 + v * w[j], 0);
      return { predict: (x) => { const z = sc.tf(x); return b0 + z.reduce((s2, v, j) => s2 + v * w[j], 0); } };
    },
    mlp(X, y, s) {
      const sc = scaler(X), Z = X.map(sc.tf), n = Z.length, rng = U.rng(s.random_seed + 3);
      const sizes = [Z[0].length, s.mlp_hidden, Math.max(4, Math.floor(s.mlp_hidden / 2)), 1];
      const W = [], B = [];
      for (let l = 0; l < 3; l++) {
        const bound = Math.sqrt(6 / (sizes[l] + sizes[l + 1]));
        W.push(U.range(0, sizes[l]).map(() => U.range(0, sizes[l + 1]).map(() => (rng() * 2 - 1) * bound)));
        B.push(U.range(0, sizes[l + 1]).map(() => (rng() * 2 - 1) * bound));
      }
      const forward = (x) => {
        const acts = [x];
        for (let l = 0; l < 3; l++) {
          const a = acts[l], out = B[l].map((b, j) => b + a.reduce((s2, v, i) => s2 + v * W[l][i][j], 0));
          acts.push(l < 2 ? out.map((v) => Math.max(0, v)) : out);
        }
        return acts;
      };
      const mW = W.map((m) => m.map((r) => r.map(() => 0))), vW = W.map((m) => m.map((r) => r.map(() => 0)));
      const mB = B.map((r) => r.map(() => 0)), vB = B.map((r) => r.map(() => 0));
      const b1 = 0.9, b2 = 0.999, eps = 1e-8, alpha = s.mlp_alpha;
      let best = Infinity, noImp = 0;
      for (let it = 1; it <= 4000; it++) {
        const gW = W.map((m) => m.map((r) => r.map(() => 0))), gB = B.map((r) => r.map(() => 0));
        let loss = 0;
        for (let t = 0; t < n; t++) {
          const acts = forward(Z[t]);
          let delta = [acts[3][0] - y[t]];
          loss += delta[0] ** 2;
          for (let l = 2; l >= 0; l--) {
            const a = acts[l];
            for (let i = 0; i < a.length; i++) for (let j = 0; j < delta.length; j++) gW[l][i][j] += a[i] * delta[j];
            for (let j = 0; j < delta.length; j++) gB[l][j] += delta[j];
            if (l > 0) delta = a.map((av, i) => (av > 0 ? delta.reduce((s2, d, j) => s2 + d * W[l][i][j], 0) : 0));
          }
        }
        let l2 = 0; W.forEach((m) => m.forEach((r) => r.forEach((v) => { l2 += v * v; })));
        loss = loss / n / 2 + (0.5 * alpha * l2) / n;
        const lrT = (0.01 * Math.sqrt(1 - Math.pow(b2, it))) / (1 - Math.pow(b1, it));
        for (let l = 0; l < 3; l++) {
          for (let i = 0; i < W[l].length; i++) for (let j = 0; j < W[l][i].length; j++) {
            const g = (gW[l][i][j] + alpha * W[l][i][j]) / n;
            mW[l][i][j] = b1 * mW[l][i][j] + (1 - b1) * g; vW[l][i][j] = b2 * vW[l][i][j] + (1 - b2) * g * g;
            W[l][i][j] -= (lrT * mW[l][i][j]) / (Math.sqrt(vW[l][i][j]) + eps);
          }
          for (let j = 0; j < B[l].length; j++) {
            const g = gB[l][j] / n;
            mB[l][j] = b1 * mB[l][j] + (1 - b1) * g; vB[l][j] = b2 * vB[l][j] + (1 - b2) * g * g;
            B[l][j] -= (lrT * mB[l][j]) / (Math.sqrt(vB[l][j]) + eps);
          }
        }
        if (loss > best - 1e-4) noImp++; else noImp = 0;
        if (loss < best) best = loss;
        if (noImp > 10) break;
      }
      return { predict: (x) => forward(sc.tf(x))[3][0] };
    },
  };
  // fitted models are cached: scenarios share the same history, so only the first run pays for fitting
  const FIT_CACHE = new Map();
  const fitCached = (key, s, X, y) => {
    const params = Object.keys(s).sort().filter((k) => k.startsWith(key + "_") || k === "random_seed").map((k) => [k, s[k]]);
    const h = key + JSON.stringify(params) + JSON.stringify(X) + JSON.stringify(y);
    if (FIT_CACHE.has(h)) return FIT_CACHE.get(h);
    const mdl = MODELS[key](X, y, s);
    if (FIT_CACHE.size > 400) FIT_CACHE.clear();
    FIT_CACHE.set(h, mdl);
    return mdl;
  };
  const fMl = (key) => (train, fut, target, s) => {
    const mode = s.ml_target_mode, lags = s.ml_lags;
    const feats = FEATURES.filter((f) => s.ml_trend || f !== "t");
    const yser = mode === "ratio" ? train.map((r) => r[target] / r.pop_65plus) : train.map((r) => r[target] / 1e6);
    const Xtr = [], ytr = [];
    train.forEach((r, i) => {
      const row = feats.map((f) => r[f]);
      for (let l = 1; l <= lags; l++) row.push(i - l >= 0 ? yser[i - l] : NaN);
      if (row.every(U.isNum)) { Xtr.push(row); ytr.push(yser[i]); }
    });
    if (ytr.length < 6) throw new Error("too few training rows");
    const mdl = fitCached(key, s, Xtr, ytr);
    const fitted = Xtr.map((x) => mdl.predict(x));
    const sigma = U.std(ytr.map((v, i) => (v - fitted[i]) / Math.max(Math.abs(v), 1e-9))) + 0.006;
    const histVals = yser.slice(), preds = [];
    const loC = U.min(yser) * 0.5, hiC = U.max(yser) * 1.6;
    for (const r of fut) {
      const row = feats.map((f) => r[f]);
      for (let l = 1; l <= lags; l++) row.push(histVals[histVals.length - l]);
      const p = U.clip(mdl.predict(row), loC, hiC);
      preds.push(p); histVals.push(p);
    }
    let mean;
    if (mode === "ratio") {
      mean = preds.map((p, i) => p * Math.pow(1 + s.ratio_drift_pct / 100, i + 1) * fut[i].pop_65plus);
      if (key === "rf" || key === "gb") {
        const ra0 = train[train.length - 1].retirement_age, raMax = Math.max(U.max(col(train, "retirement_age")), ra0);
        mean = mean.map((m, i) => m * U.clip(1 - (s.ret_age_elasticity / 100) * Math.max(0, fut[i].retirement_age - raMax), 0.3, 1.5));
      }
    } else mean = preds.map((p) => p * 1e6);
    const b = band(mean, sigma, zOf(s));
    return { mean, lo: b.lo, hi: b.hi };
  };
  M.FORECASTERS = { arima: M.fArima, ets: M.fEts, structural: M.fStructural, rf: fMl("rf"), gb: fMl("gb"), ridge: fMl("ridge"), mlp: fMl("mlp") };

  // ------------------------------------------------------------------ pensioners by sex
  M.retAgeBySex = (year, avg) => {
    const men = year <= 1997 ? 60 : year <= 1999 ? 61 : year <= 2013 ? 62 : avg;
    return [men, 2 * avg - men];
  };
  const dampedRatio = (ratio, n, s) => {
    const w = Math.min(s.ratio_window, ratio.length), rr = ratio.slice(-w);
    const { a, b } = U.polyfit1(U.range(0, w), rr);
    const sigma = U.std(rr.map((v, i) => v - (a + b * i))) / Math.max(Math.abs(rr[rr.length - 1]), 1e-9) + 0.004;
    const out = U.range(1, n + 1).map((h) => {
      let damp = 0; for (let k = 1; k <= h; k++) damp += Math.pow(s.ratio_phi, k);
      return U.clip((rr[rr.length - 1] + b * damp) * Math.pow(1 + s.ratio_drift_pct / 100, h), U.min(rr) * 0.5, U.max(rr) * 1.5);
    });
    return { r: out, sigma };
  };
  M.sexSplit = (ds, s, hist, fut, pop, ens) => {
    const target = s.target, cm = `${target}_m`, cf = `${target}_f`, T = ds.T;
    const ages = pop.ages_sex;
    const raAll = ds.years.filter((y) => U.isNum(T.get(y).retirement_age));
    const raLastVal = T.get(raAll[raAll.length - 1]).retirement_age;
    const futBy = new Map(fut.map((r) => [r.year, r]));
    const ret = new Map();
    for (let y = ds.years[0]; y <= fut[fut.length - 1].year; y++) {
      const avg = futBy.has(y) ? futBy.get(y).retirement_age : (T.has(y) && U.isNum(T.get(y).retirement_age) ? T.get(y).retirement_age : raLastVal);
      ret.set(y, M.retAgeBySex(y, avg));
    }
    const out = { available: false, ret_age_men: Object.fromEntries([...ret].map(([y, v]) => [y, v[0]])), ret_age_women: Object.fromEntries([...ret].map(([y, v]) => [y, v[1]])) };
    const yrs = hist.map((r) => r.year).filter((y) => T.has(y) && ages.has(y) && U.isNum(T.get(y)[cm]) && U.isNum(T.get(y)[cf]));
    if (yrs.length < 8) return out;
    const adj = 1 + s.elderly_pop_adj_pct / 100;
    const elig = (y, sx) => POP.popAtOrAbove(ages.get(y)[sx], ret.get(y)[sx === "M" ? 0 : 1]) * (futBy.has(y) ? adj : 1);
    const H = yrs.map((y) => ({ year: y, men: T.get(y)[cm], women: T.get(y)[cf], el_m: elig(y, "M"), el_f: elig(y, "F") }));
    const fy = fut.map((r) => r.year).filter((y) => ages.has(y));
    const elM = fy.map((y) => elig(y, "M")), elF = fy.map((y) => elig(y, "F"));
    const forecast = (Hs, em, ef, ss) => {
      const rm = dampedRatio(Hs.map((h) => h.men / h.el_m), em.length, ss).r, rf = dampedRatio(Hs.map((h) => h.women / h.el_f), ef.length, ss).r;
      return [rm.map((v, i) => v * em[i]), rf.map((v, i) => v * ef[i])];
    };
    const [rawM, rawF] = forecast(H, elM, elF, s);
    const shareF = rawF.map((v, i) => v / (rawM[i] + v));
    const n = Math.min(s.test_years, yrs.length - 8);
    const tr = H.slice(0, H.length - n), te = H.slice(H.length - n);
    const [bm, bf] = forecast(tr, te.map((h) => h.el_m), te.map((h) => h.el_f), { ...s, ratio_drift_pct: 0 });
    const shPred = bf.map((v, i) => v / (bm[i] + v)), shObs = te.map((h) => h.women / (h.men + h.women)), totObs = te.map((h) => h.men + h.women);
    const mape = (a, b) => U.mean(a.map((v, i) => Math.abs((v - b[i]) / b[i]))) * 100;
    const pred = ens.pred.slice(0, fy.length), lo = ens.lo.slice(0, fy.length), hi = ens.hi.slice(0, fy.length);
    Object.assign(out, {
      available: true,
      hist_years: yrs, men: H.map((h) => h.men), women: H.map((h) => h.women),
      share_women_hist: H.map((h) => (h.women / (h.men + h.women)) * 100),
      ratio_men_hist: H.map((h) => h.men / h.el_m), ratio_women_hist: H.map((h) => h.women / h.el_f),
      eligible_men_hist: H.map((h) => h.el_m), eligible_women_hist: H.map((h) => h.el_f),
      future_years: fy,
      men_pred: pred.map((v, i) => v * (1 - shareF[i])), women_pred: pred.map((v, i) => v * shareF[i]),
      men_lo: lo.map((v, i) => v * (1 - shareF[i])), women_lo: lo.map((v, i) => v * shareF[i]),
      men_hi: hi.map((v, i) => v * (1 - shareF[i])), women_hi: hi.map((v, i) => v * shareF[i]),
      share_women_fut: shareF.map((v) => v * 100), raw_men: rawM, raw_women: rawF,
      eligible_men_fut: elM, eligible_women_fut: elF,
      ratio_men_fut: rawM.map((v, i) => v / elM[i]), ratio_women_fut: rawF.map((v, i) => v / elF[i]),
      backtest: { years: te.map((h) => h.year), share_women_pred: shPred.map((v) => v * 100), share_women_obs: shObs.map((v) => v * 100),
        share_mae_pp: U.mean(shPred.map((v, i) => Math.abs(v - shObs[i]))) * 100,
        mape_men: mape(totObs.map((t, i) => t * (1 - shPred[i])), te.map((h) => h.men)),
        mape_women: mape(totObs.map((t, i) => t * shPred[i]), te.map((h) => h.women)) },
    });
    return out;
  };

  // ------------------------------------------------------------------ orchestration
  const metrics = (actual, pred) => {
    const err = pred.map((p, i) => p - actual[i]);
    return { mae: U.mean(err.map(Math.abs)), rmse: Math.sqrt(U.mean(err.map((e) => e * e))), mape: U.mean(err.map((e, i) => Math.abs(e / actual[i]))) * 100 };
  };
  M.run = (ds, s, popVariants = true) => {
    const t0 = Date.now(), target = s.target;
    const pop = POP.run(ds, s, s.projection_variant, popVariants);
    const { hist, fut, notes, source } = M.buildFrames(ds, s, pop);
    if (hist.length < 12) throw new Error("At least 12 historical years are needed. Lower the first historical year.");
    const enabled = SET.MODEL_KEYS.filter((k) => s[`use_${k}`]);
    if (!enabled.length) throw new Error("Switch on at least one model.");
    const nTest = Math.min(s.test_years, hist.length - 10);
    const trainBt = hist.slice(0, hist.length - nTest), testBt = hist.slice(hist.length - nTest);
    const sBt = { ...s, ratio_drift_pct: 0 };
    const models = {}, warnings = notes.slice();
    for (const k of enabled) {
      const entry = { label: SET.MODEL_LABELS[k], ok: false };
      try {
        const bt = M.FORECASTERS[k](trainBt, testBt, target, sBt);
        entry.backtest = { years: testBt.map((r) => r.year), pred: bt.mean };
        entry.metrics = metrics(col(testBt, target), bt.mean);
        const fc = M.FORECASTERS[k](hist, fut, target, s);
        if (!fc.mean.every(Number.isFinite)) throw new Error("non-finite forecast");
        Object.assign(entry, { pred: fc.mean, lo: fc.lo, hi: fc.hi, ok: true });
      } catch (e) {
        entry.error = `${e.name || "Error"}: ${e.message}`;
        warnings.push(`${SET.MODEL_LABELS[k]} skipped – ${entry.error}`);
      }
      models[k] = entry;
    }
    const ok = enabled.filter((k) => models[k].ok);
    if (!ok.length) throw new Error("All models failed: " + warnings.join("; "));
    let raw;
    if (s.ensemble_mode === "manual") { raw = Object.fromEntries(ok.map((k) => [k, s[`w_${k}`]])); if (U.sum(Object.values(raw)) === 0) raw = Object.fromEntries(ok.map((k) => [k, 1])); }
    else if (s.ensemble_mode === "equal") raw = Object.fromEntries(ok.map((k) => [k, 1]));
    else raw = Object.fromEntries(ok.map((k) => [k, 1 / Math.max(models[k].metrics.mape, 0.05)]));
    const tot = U.sum(Object.values(raw)), weights = Object.fromEntries(ok.map((k) => [k, raw[k] / tot]));
    const comb = (key) => fut.map((_, i) => ok.reduce((s2, k) => s2 + models[k][key][i] * weights[k], 0));
    const ens = { pred: comb("pred"), lo: comb("lo"), hi: comb("hi") };
    const btEns = testBt.map((_, i) => ok.reduce((s2, k) => s2 + models[k].backtest.pred[i] * weights[k], 0));
    const ensMetrics = metrics(col(testBt, target), btEns);
    const bySex = M.sexSplit(ds, s, hist, fut, pop, ens);
    const yearsF = fut.map((r) => r.year), lastVal = hist[hist.length - 1][target];
    const milestones = [];
    for (const y of [...MILESTONES, s.end_year]) {
      if (!yearsF.includes(y) || milestones.some((m) => m.year === y)) continue;
      const i = yearsF.indexOf(y);
      milestones.push({ year: y, value: ens.pred[i], lo: ens.lo[i], hi: ens.hi[i], change_pct: (ens.pred[i] / lastVal) * 100 - 100,
        per_1000: (ens.pred[i] / fut[i].population) * 1000, retirement_age: fut[i].retirement_age,
        by_model: Object.fromEntries(ok.map((k) => [k, models[k].pred[i]])),
        men: bySex.available ? bySex.men_pred[i] : null, women: bySex.available ? bySex.women_pred[i] : null });
    }
    milestones.sort((a, b) => a.year - b.year);
    const exog = ["population", "pop_65plus", "share_65plus", "life_expectancy", "retirement_age", "pop_ret_age"];
    const frameRows = (fr) => fr.map((r) => ({ year: r.year, ...Object.fromEntries(exog.map((c) => [c, U.isNum(r[c]) ? r[c] : null])) }));
    const exact = fut.every((r) => U.isNum(r.pop_ret_age)) && hist.every((r) => U.isNum(r.pop_ret_age));
    const popOut = { ...pop }; delete popOut.ages_total; delete popOut.ages_sex;
    return {
      target, target_label: target === "pensioners_total" ? "All pension & benefit recipients" : "Old-age pensioners",
      hist_years: hist.map((r) => r.year), hist_values: col(hist, target), future_years: yearsF,
      models, enabled, weights, ensemble: ens, ensemble_metrics: ensMetrics,
      ensemble_backtest: { years: testBt.map((r) => r.year), pred: btEns }, milestones,
      last_actual: { year: hist[hist.length - 1].year, value: lastVal },
      hist_exog: frameRows(hist), future_exog: frameRows(fut),
      denominator: exact ? `population at or above the retirement age (${{ ccm: "KSH ages + cohort-component projection", eurostat: "KSH ages + Eurostat EUROPOP", fallback: "KSH ages" }[source] || ""})` : "population aged 65+ with retirement-age elasticity",
      population_source: source, population: popOut, by_sex: bySex, warnings,
      runtime_s: Math.round((Date.now() - t0) / 10) / 100,
    };
  };
})(globalThis);
