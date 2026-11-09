"""Run the Python engine on fixed cases and save its outputs, for checking the JavaScript port.

usage: python tools/make_reference.py ../pension_sim tests/reference.json
"""
import json
import math
import sys
from pathlib import Path

src = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(src))
import numpy as np  # noqa: E402

from core import data_sources as ds_mod, scenarios, settings  # noqa: E402
from core.models import FORECASTERS, build_frames, run_simulation  # noqa: E402
from core.population import run_population  # noqa: E402


def clean(o):
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, np.ndarray):
        return clean(o.tolist())
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating, float)):
        return None if (math.isnan(o) or math.isinf(o)) else float(o)
    return o


CASES = {
    "default": {},
    "oldage": {"target": "oldage_pensioners"},
    "reform": {"ret_age_target": 67, "link_ret_age_le": True, "ensemble_mode": "manual",
               "use_mlp": True, "ml_target_mode": "level", "w_rf": 0.2},
    "fallback": {"population_source": "fallback", "break_dummy_2012": False},
    "long": {"end_year": 2070, "tfr_target": 1.6, "net_migration": 30000, "conf_level": "0.95"},
    "tsvariants": {"arima_p": 2, "arima_q": 1, "ets_damped": False, "arima_log": False, "ets_log": False,
                   "ml_lags": 2, "ml_trend": False, "start_year": 1995, "test_years": 8},
}
ds = ds_mod.build_dataset("BSL")
out = {"dataset": {"table": ds["table"].to_dict("records"), "prov": ds["provenance"].to_dict("records"),
                   "last_hist_year": ds["last_hist_year"]}, "cases": {}}
for name, raw in CASES.items():
    s = settings.validate(raw)
    res = run_simulation(ds, s)
    pop = run_population(ds["table"], s, s["projection_variant"])
    hist, fut, _ = build_frames(ds, s, pop)
    n_test = min(s["test_years"], len(hist) - 10)
    # each model forecast on full history (separately from the ensemble), for per-model comparison
    out["cases"][name] = {"settings": s, "result": res,
                          "frames": {"hist": hist.reset_index().to_dict("records"),
                                     "fut": fut.reset_index().to_dict("records")}}
    print(name, [(m["year"], round(m["value"])) for m in res["milestones"]])
sel = {"ret_age_up": 2, "immigration_up": 20000, "longevity_fast": 1.0, "later_births": 1.0}
sr = scenarios.run_scenarios(ds, settings.validate({}), sel, "Reference mix", presets=True, impacts=True,
                             impact_mode="within")
out["scenario"] = {k: v for k, v in sr.items()}
out["scenario"]["scenarios"] = [{k: v for k, v in sc.items() if k != "full"} for sc in sr["scenarios"]]
sr2 = scenarios.run_scenarios(ds, settings.validate({}), {p["key"]: p["default"] for p in scenarios.PARAMS},
                              "All", presets=False, impacts=True, impact_mode="alone")
out["scenario_alone"] = {"impacts": sr2["impacts"]}
Path(sys.argv[2]).write_text(json.dumps(clean(out)), encoding="utf-8")
print("wrote", sys.argv[2])
