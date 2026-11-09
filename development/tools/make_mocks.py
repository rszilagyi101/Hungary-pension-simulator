"""Build mock KSH CSV files and Eurostat JSON-stat responses for testing the download path.
The mocks use the bundled data with deliberate changes, so a successful download is visible."""
import json, sys
from pathlib import Path
import pandas as pd

src = Path(sys.argv[1]); out = Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)
h = pd.read_csv(src / "data/default_history.csv")
ages = pd.read_csv(src / "data/ksh_age_sex.csv")
vital = pd.read_csv(src / "data/ksh_vital.csv")
sp = lambda v: f"{int(round(v)):,}".replace(",", " ")      # KSH style thousands separator
dec = lambda v: f"{v:.1f}".replace(".", ",")

def write(name, lines):
    (out / name).write_bytes(("\r\n".join(lines) + "\r\n").encode("cp1250"))

# szo0002: long series, last column = recipients in thousands (1990-2025); add 2026 with a marker value
L = ["25.1.1.2. A szociális ellátás főbb, hosszú idősoros adatai", "Év;Családi pótlék;Bölcsőde;Nyugdíjas, ezer"]
for _, r in h[h.year <= 2025].iterrows():
    L.append(f"{int(r.year)};1 000;30 000d;{sp(r.pensioners_total / 1000)}")
write("szo0002.csv", L)
# szo0034: blocks Férfi / Nő / Összesen; 2026 total bumped by +1000 to show the download took effect
L = ["25.1.1.38. Nyugdíjban, ellátásban ...", "Év;összesen;öregségi nyugdíjasok;életkoron alapuló", "Férfi;;;"]
for _, r in h[h.year >= 2000].iterrows(): L.append(f"{int(r.year)};{sp(r.pensioners_total_m)};{sp(r.oldage_pensioners_m)};..")
L.append("Nő;;;")
for _, r in h[h.year >= 2000].iterrows(): L.append(f"{int(r.year)};{sp(r.pensioners_total_f)};{sp(r.oldage_pensioners_f)};..")
L.append("Összesen;;;")
for _, r in h[h.year >= 2000].iterrows(): L.append(f"{int(r.year)};{sp(r.pensioners_total + (1000 if r.year == 2026 else 0))};{sp(r.oldage_pensioners)};..")
write("szo0034.csv", L)
# nep0001: wide table with sections
hp = h.dropna(subset=["population"])
years = [int(y) for y in hp.year]
L = ["22.1.1.1. A népesség, népmozgalom főbb mutatói", "Megnevezés;" + ";".join(str(y) for y in years),
     "A népesség száma, január 1.a;" + ";" * (len(years) - 1),
     "férfi;" + ";".join("1" for _ in years),
     "összesen;" + ";".join(sp(v) for v in hp.population),
     "Születéskor várható átlagos élettartam, év;" + ";" * (len(years) - 1),
     "férfi;" + ";".join("70,0" for _ in years),
     "összesen;" + ";".join((f"{v:.2f}".replace(".", ",") if v == v else "..") for v in hp.life_expectancy)]
write("nep0001.csv", L)
# nep0004
L = ["22.1.1.4. A népesség összetétele", "Év, január 1.;0–14;15–64;65–"]
for _, r in hp.iterrows(): L.append(f"{int(r.year)};14,0;65,0;{dec(r.share_65plus)}")
write("nep0004.csv", L)
# nep0003: ages by sex for the bundled years plus 2004 (so a downloaded year exists that the bundle lacks)
ay = sorted(ages.year.unique())
a2004 = ages[ages.year == 2001].copy(); a2004["year"] = 2004
A = pd.concat([ages, a2004])
ay = sorted(A.year.unique())
L = ["22.1.1.3. Népesség korév és nem szerint, január 1.", "Korév;" + ";".join(str(y) for y in ay)]
for sexlab, sx in (("Férfi", "M"), ("Nő", "F")):
    L.append(sexlab + ";" * len(ay))
    for a in range(91):
        lab = "90–" if a == 90 else str(a)
        L.append(lab + ";" + ";".join(sp(A[(A.year == y) & (A.sex == sx) & (A.age == a)].population.iloc[0]) for y in ay))
    L.append("Összesen;" + ";".join(sp(A[(A.year == y) & (A.sex == sx)].population.sum()) for y in ay))
L.append("Összesen" + ";" * len(ay))
L.append("0;" + ";".join("1" for _ in ay))
write("nep0003.csv", L)

# Eurostat JSON-stat: demo_pjan 1990-2025 from KSH ages spread over 0..100 (Y_LT1, Y1..Y99, Y_OPEN), plus TOTAL/UNK noise
def jsonstat(years, val):
    agecodes = ["TOTAL", "Y_LT1"] + [f"Y{a}" for a in range(1, 100)] + ["Y_OPEN", "UNK"]
    ids = ["freq", "unit", "age", "sex", "geo", "time"]
    cats = {"freq": ["A"], "unit": ["NR"], "age": agecodes, "sex": ["F", "M"], "geo": ["HU"], "time": [str(y) for y in years]}
    sizes = [len(cats[d]) for d in ids]
    values = {}
    for ia, ac in enumerate(agecodes):
        for isx, sx in enumerate(cats["sex"]):
            for it, y in enumerate(years):
                v = val(ac, sx, y)
                if v is None: continue
                flat = ((((0 * 1 + 0) * sizes[2] + ia) * sizes[3] + isx) * sizes[4] + 0) * sizes[5] + it
                values[str(flat)] = v
    return {"version": "2.0", "class": "dataset", "id": ids, "size": sizes,
            "dimension": {d: {"category": {"index": {c: i for i, c in enumerate(cats[d])}}} for d in ids}, "value": values}
known = {(int(r.year), r.sex, int(r.age)): float(r.population) for r in ages.itertuples()}
kyears = sorted({y for y, _, _ in known})
def base_age(sx, y, a):
    y0 = max(k for k in kyears if k <= y) if y >= kyears[0] else kyears[0]
    v = known[(y0, sx, min(a, 90))]
    return v / 11 if a >= 90 else v
def demo(ac, sx, y):
    if ac in ("TOTAL", "UNK"): return 123.0
    a = 0 if ac == "Y_LT1" else (100 if ac == "Y_OPEN" else int(ac[1:]))
    return round(base_age(sx, y, a) * (1.002 if y not in kyears else 1.0))
(out / "demo_pjan.json").write_text(json.dumps(jsonstat(list(range(1985, 2026)), demo)))
def proj(ac, sx, y):
    if ac in ("TOTAL", "UNK"): return 123.0
    a = 0 if ac == "Y_LT1" else (100 if ac == "Y_OPEN" else int(ac[1:]))
    return round(base_age(sx, 2026, a) * (0.996 ** (y - 2026)) * (1.0 + 0.004 * (y - 2026) * (a >= 65)))
(out / "proj_BSL.json").write_text(json.dumps(jsonstat(list(range(2025, 2101)), proj)))
print("mocks written to", out)
