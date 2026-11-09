// Same downloaded data (PHP payload) -> same dataset and results as the Python app (its own download).
const PS = require("./load")();
const fs = require("fs");
// usage: node check_online.js <folder with refresh.json (api.php refresh answer) and py_online.json (desktop app output)>
const SP = process.argv[2] || ".";
const payload = JSON.parse(fs.readFileSync(SP + "/refresh.json", "utf8"));
const py = JSON.parse(fs.readFileSync(SP + "/py_online.json", "utf8"));
PS.data.setOfficial(payload);
PS.population.resetCache();
const ds = PS.data.buildDataset("BSL");
let worst = 0, wl = "", provBad = 0;
py.table.forEach((row, i) => {
  const mine = ds.T.get(row.year);
  if (!mine) { console.log("missing year", row.year); return; }
  for (const c of PS.data.COLUMNS) {
    const a = Number.isFinite(mine[c]) ? mine[c] : null, b = row[c];
    if ((a === null) !== (b === null)) { console.log("presence differs", row.year, c, a, b); continue; }
    if (a !== null) { const r = Math.abs(a - b) / Math.max(Math.abs(b), 1e-9); if (r > worst) { worst = r; wl = `${row.year} ${c}`; } }
    if ((ds.P.get(row.year)[c] || "") !== (py.prov[i][c] || "")) { provBad++; if (provBad <= 6) console.log("provenance", row.year, c, JSON.stringify(ds.P.get(row.year)[c]), "py", JSON.stringify(py.prov[i][c])); }
  }
});
console.log(`dataset after download: worst rel diff ${worst.toExponential(2)} (${wl}), provenance mismatches ${provBad}, age detail js ${ds.hasAgeDetail} py ${py.has_age_detail}`);
for (const name of ["ccm", "eurostat"]) {
  const s = PS.settings.validate(name === "eurostat" ? { population_source: "eurostat" } : {});
  const r = PS.models.run(ds, s);
  const P = py.runs[name];
  console.log(`${name}: ` + r.milestones.map((m, i) => `${m.year} js ${Math.round(m.value)} py ${Math.round(P.milestones[i].value)} (${(((m.value - P.milestones[i].value) / P.milestones[i].value) * 100).toFixed(2)}%)`).join(" | "));
  console.log(`   denominator same: ${r.denominator === P.denominator} | pyramid 2004 (downloaded-only year) men age 40 js ${r.population.pyramids[2004].M[40]} py ${P.pyr2004.M[40]} | pyramid 2001 F90+ js ${r.population.pyramids[2001].F[90]} py ${P.pyr2001.F[90]}`);
  const t = (y) => [r.population.eurostat_totals[y], P.es_tot[y]];
  console.log(`   Eurostat total 2050 js ${Math.round(t(2050)[0])} py ${Math.round(t(2050)[1])}`);
}
