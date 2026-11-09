const PS = require("./load")(["ps-defaults.js", "ps-core.js", "ps-data.js", "ps-population.js"]);
const ref = JSON.parse(require("fs").readFileSync(__dirname + "/reference.json", "utf8"));
const rel = (a, b) => (b === 0 ? Math.abs(a) : Math.abs(a - b) / Math.abs(b));
let worst = { v: 0 };
const cmp = (label, a, b) => { if (a === null && b === null) return; const r = rel(a, b); if (!(r <= worst.v)) worst = { v: r, label, a, b }; };
// dataset
const ds = PS.data.buildDataset("BSL");
const rt = ref.dataset.table, rp = ref.dataset.prov;
let provBad = 0;
rt.forEach((row, i) => {
  const y = row.year, mine = ds.T.get(y);
  for (const c of PS.data.COLUMNS) {
    const a = Number.isFinite(mine[c]) ? mine[c] : null, b = row[c];
    if ((a === null) !== (b === null)) { console.log("missing mismatch", y, c, a, b); continue; }
    if (a !== null) cmp(`table ${y} ${c}`, a, b);
    if ((ds.P.get(y)[c] || "") !== (rp[i][c] || "")) { provBad++; if (provBad < 5) console.log("prov", y, c, ds.P.get(y)[c], rp[i][c]); }
  }
});
console.log("dataset: rows", ds.years.length, "vs", rt.length, "| worst rel diff", worst.v.toExponential(2), worst.label || "", "| provenance mismatches", provBad, "| last hist", ds.lastHist);
// population, default case
for (const name of ["default", "long"]) {
  worst = { v: 0 };
  const s = PS.settings.validate(ref.cases[name].settings);
  const pop = PS.population.run(ds, s);
  const rpop = ref.cases[name].result.population;
  rpop.rows.forEach((r, i) => { for (const k of ["total", "total_low", "total_high", "age_65_plus_f", "median_age", "old_age_dependency", "births", "deaths", "net_migration"]) if (r[k] !== undefined && r[k] !== null) cmp(`pop ${r.year} ${k}`, pop.rows[i][k], r[k]); });
  for (const y of Object.keys(rpop.pyramids)) rpop.pyramids[y].M.forEach((v, a) => { if (v > 50) cmp(`pyr ${y} M${a}`, pop.pyramids[y].M[a], v); });
  rpop.validation.rows.forEach((r, i) => cmp("val " + r.indicator, pop.validation.rows[i].projected, r.projected));
  console.log(`population ${name}: rows ${pop.rows.length} vs ${rpop.rows.length} | worst rel diff ${worst.v.toExponential(2)} ${worst.label}`);
}
