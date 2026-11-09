const PS = require("./load")();
const ref = JSON.parse(require("fs").readFileSync(__dirname + "/reference.json", "utf8"));
const ds = PS.data.buildDataset("BSL");
const pct = (a, b) => ((a - b) / Math.abs(b)) * 100;
const only = process.argv[2];
for (const [name, c] of Object.entries(ref.cases)) {
  if (only && name !== only) continue;
  const s = PS.settings.validate(c.settings);
  const t0 = Date.now();
  const r = PS.models.run(ds, s);
  const R = c.result;
  const H = R.future_years.length, idx = [3, 13, 23].filter((i) => i < H);
  console.log(`\n== ${name}  (${Date.now() - t0} ms)  warnings: ${JSON.stringify(r.warnings)}`);
  for (const k of R.enabled) {
    const a = r.models[k], b = R.models[k];
    if (!a.ok || !b.ok) { console.log(k.padEnd(10), "ok js/py", a.ok, b.ok, a.error || ""); continue; }
    const d = idx.map((i) => pct(a.pred[i], b.pred[i]).toFixed(2)).join(" ");
    console.log(k.padEnd(10), "pred %diff at +4/+14/+24y:", d.padEnd(22), "| MAPE js", a.metrics.mape.toFixed(2), "py", b.metrics.mape.toFixed(2),
      "| band width js/py", ((a.hi[H - 1] - a.lo[H - 1]) / (b.hi[H - 1] - b.lo[H - 1])).toFixed(3), "| weight js", (r.weights[k] || 0).toFixed(3), "py", (R.weights[k] || 0).toFixed(3));
  }
  console.log("ensemble milestones:", r.milestones.map((m, i) => `${m.year}: js ${Math.round(m.value)} py ${Math.round(R.milestones[i].value)} (${pct(m.value, R.milestones[i].value).toFixed(2)}%)`).join(" | "));
  if (r.by_sex.available) console.log("by sex 2050 women share js", r.by_sex.share_women_fut[23]?.toFixed(2), "py", R.by_sex.share_women_fut[23]?.toFixed(2), "| backtest share MAE js", r.by_sex.backtest.share_mae_pp.toFixed(3), "py", R.by_sex.backtest.share_mae_pp.toFixed(3));
}
