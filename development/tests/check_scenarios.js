const PS = require("./load")();
const ref = JSON.parse(require("fs").readFileSync(__dirname + "/reference.json", "utf8"));
(async () => {
  const ds = PS.data.buildDataset("BSL");
  const t0 = Date.now();
  const sel = { ret_age_up: 2, immigration_up: 20000, longevity_fast: 1.0, later_births: 1.0 };
  const sr = await PS.scenarios.run(ds, PS.settings.validate({}), sel, { name: "Reference mix", presets: true, impacts: true, impactMode: "within" });
  console.log(`scenario run: ${sr.scenarios.length} scenarios + ${sr.impacts.length} impacts in ${Date.now() - t0} ms`);
  const R = ref.scenario;
  for (const sc of sr.scenarios) {
    const rs = R.scenarios.find((x) => x.id === sc.id);
    const m = sc.milestones.find((x) => x.year === 2050), rm = rs.milestones.find((x) => x.year === 2050);
    console.log(`${sc.id.padEnd(12)} 2050 recipients js ${Math.round(m.pensioners)} py ${Math.round(rm.pensioners)} | burden js ${m.dependency.toFixed(2)} py ${rm.dependency.toFixed(2)} | changes ${sc.changes.length}/${rs.changes.length}`);
  }
  for (const i of sr.impacts) { const r = R.impacts.find((x) => x.key === i.key); console.log(`  impact ${i.key.padEnd(15)} js ${i.d_dependency.toFixed(2)} py ${r.d_dependency.toFixed(2)} | ${i.status} / ${r.status}`); }
  const t1 = Date.now();
  const all = Object.fromEntries(PS.scenarios.PARAMS.map((p) => [p.key, p.default]));
  const sa = await PS.scenarios.run(ds, PS.settings.validate({}), all, { name: "All", presets: false, impacts: true, impactMode: "alone" });
  let agree = 0;
  for (const i of sa.impacts) { const r = ref.scenario_alone.impacts.find((x) => x.key === i.key); if (i.status === r.status) agree++; else console.log("  status differs", i.key, i.status, "|", r.status, i.d_dependency.toFixed(2), r.d_dependency.toFixed(2)); }
  console.log(`all 17 parameters alone: ${Date.now() - t1} ms, status agrees for ${agree}/${sa.impacts.length}`);
})();
