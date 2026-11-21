"""Write notebook.ipynb (the code walk-through) from the cells below. Then run it with:
    jupyter nbconvert --to notebook --execute --inplace notebook.ipynb
"""
from pathlib import Path

import nbformat as nbf

ROOT = Path(__file__).resolve().parent.parent
cells = []
md = lambda s: cells.append(nbf.v4.new_markdown_cell(s.strip()))
code = lambda s: cells.append(nbf.v4.new_code_cell(s.strip()))

md("""
# Virtual flow metering and build-up analysis

SOCAR hackathon: ten gas-lifted oil wells, January to September 2025.

* **Phase 1 (VFM):** estimate daily oil, water and gas for every well from sensors only.
  Well-test rates are used only as training labels. `pta_results.csv` is not used at all.
* **Phase 2 (PTA):** Horner analysis of every shut-in, using the Phase 1 oil rate.

The notebook runs the same code as the command line (`src/`) and the web app (`app.py`).
Raw files in `data/` are never changed; all cleaning is done in code.
""")
code("""
import sys, warnings, json
sys.path.insert(0, "src")
warnings.filterwarnings("ignore")
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from IPython.display import Image, display

from data import DATA, NULL_CODE, SENSORS, load_high_freq, load_static, load_well_tests
from features import CALIBRATED, window_features, daily_features
from vfm_model import PhysicsIPR
import train, pta, predict, reports
from submission import build as build_submission

%matplotlib inline
pd.set_option("display.width", 160, "display.max_columns", 30)
plt.rcParams.update({"figure.dpi": 110, "axes.spines.top": False, "axes.spines.right": False, "axes.grid": True, "grid.alpha": .25})
""")

md("""
## 1. Data and cleaning

* 1-minute sensors: duplicate minutes dropped, the `-999.25` null code and physically impossible values blanked.
* Choke events are attached to every minute; choke 0% = shut in.
* Well tests: negative (sign-flipped) rates made positive; GL-06 gas reported in m³ instead of Mscf is converted.
""")
code("""
src = DATA / "high_freq_data.csv"
raw = pd.read_csv(src if src.exists() else DATA / "high_freq_data.zip", nrows=2_000_000)
print("First 2M raw rows: duplicates", raw.duplicated(["well_name", "timestamp"]).sum(),
      "| -999.25 codes", int((raw[SENSORS] == NULL_CODE).sum().sum()))
del raw
hf, tests, static = load_high_freq(), load_well_tests(), load_static()
print(f"Clean sensor rows: {len(hf):,}  wells: {hf.well_name.nunique()}  "
      f"from {hf.timestamp.min():%Y-%m-%d} to {hf.timestamp.max():%Y-%m-%d}")
print(f"Well tests: {len(tests)}")
hf[SENSORS].describe().round(1)
""")
code("""
fig, ax = plt.subplots(2, 1, figsize=(12, 5), sharex=True)
g = hf[(hf.well_name == "GL-01") & (hf.timestamp.between("2025-04-10", "2025-04-25"))]
ax[0].plot(g.timestamp, g.dh_pressure_psia, lw=.7, color="#5856D6"); ax[0].set_ylabel("Downhole psia")
ax[1].plot(g.timestamp, g.choke_opening_pct, lw=1, color="#34C759"); ax[1].set_ylabel("Choke %")
ax[0].set_title("GL-01 around the 15 April shut-in: the pressure build-up used in Phase 2", loc="left");
""")

md("""
## 2. Features

Sensors are averaged over each well-test window (training rows) and over each flowing day (prediction rows).
`days` is the time since 1 Jan 2025, so each well can drift slowly (depletion, rising water cut).
""")
code("""
X = window_features(hf, tests, static)
daily_in = daily_features(hf, static)
X[["well_name", "days", *SENSORS, "choke_opening_pct", "tubing_gradient"]].head()
""")

md("""
## 3. Choosing the model (Phase 1)

Four sets of inputs × several models are compared with checks that never let the model see the answers:

* `choose_model_apr_jun`: for each month April to June, train on all earlier tests and predict that month. **Used to pick the model.**
* `final_check_jul_sep`: the same for July to September, scored once with the chosen model. **The reported number.**
* `leave_one_well_out`: hide a whole well, to see how a model does on a brand-new well.

Set 4, *well-calibrated*, gives each well its own inflow line (liquid rate vs downhole pressure),
water-cut level and time trend; oil = liquid × (1 − WC), gas = oil × the well's own GOR.
This takes about 3 minutes.
""")
code("""
res, preds = train.evaluate(X, tests)
table = res.pivot_table(index=["cv", "feature_set", "model"], columns="phase", values="mape_pct").round(1)
table["mean"] = table.mean(axis=1).round(1)
table.loc[["choose_model_apr_jun", "final_check_jul_sep"]]
""")
code("""
sel, hold = table.loc["choose_model_apr_jun"], table.loc["final_check_jul_sep"]
rows = []
for s in sel.index.get_level_values(0).unique():
    m = sel.loc[s, "mean"].idxmin()
    rows.append({"feature_set": s, "chosen_model": m, "choose_model_apr_jun_mape": sel.loc[(s, m), "mean"],
                 **{f"final_check_{p}_mape": hold.loc[(s, m), p] for p in ["oil", "water", "gas"]},
                 "final_check_mean_mape": hold.loc[(s, m), "mean"]})
per_set = pd.DataFrame(rows)
best = per_set.loc[per_set.choose_model_apr_jun_mape.idxmin()]
print(f"Chosen on April-June: {best.feature_set} + {best.chosen_model}")
print(f"Error on unseen July-September well tests: {best.final_check_mean_mape}% (MAPE)")
per_set
""")
code("""
# WAPE (total absolute error / total rate) for the chosen model on July-September
f = preds[(preds.cv == "final_check_jul_sep") & (preds.feature_set == best.feature_set) & (preds.model == best.chosen_model)]
wape = f.groupby("phase").apply(lambda g: 100 * (g.predicted - g.measured).abs().sum() / g.measured.sum()).round(1)
print("WAPE % on July-September:", wape.to_dict())
fig, axes = plt.subplots(1, 3, figsize=(13, 4))
for ax, (ph, c) in zip(axes, [("oil", "#A2845E"), ("water", "#30B0C7"), ("gas", "#FF9500")]):
    g = f[f.phase == ph]; top = g[["measured", "predicted"]].max().max() * 1.05
    ax.scatter(g.measured, g.predicted, color=c, s=25); ax.plot([0, top], [0, top], "--", color="grey", lw=1)
    ax.set_title(f"{ph}: estimated vs measured (Jul-Sep)", loc="left"); ax.set_xlabel("measured"); ax.set_ylabel("estimated")
plt.tight_layout()
""")

md("""
### Is it overfitting?

1. Error on the tests it learned from vs on the next, unseen month.
2. Simple baselines: repeat the well's last test, or its average.
3. Shuffle the sensors within each well: if the error barely changed, the model would only be memorising well averages.
4. Error month by month.
""")
code("""
W = sorted(tests.well_name.unique()); PH = ["oil_rate_stbd", "water_rate_stbd", "gas_rate_mscfd"]
Xc = X[["well_name"] + CALIBRATED]
mape = lambda P, idx: np.mean([100 * np.mean(np.abs(P.loc[idx, c] - tests.loc[idx, c]) / tests.loc[idx, c]) for c in PH])
def roll(Xd, months):
    P = pd.concat([PhysicsIPR(W).fit(Xd.loc[tr], tests.loc[tr]).predict(Xd.loc[te]) for tr, te in train.rolling(tests, months)])
    return mape(P, P.index)
seen = np.mean([mape(PhysicsIPR(W).fit(Xc.loc[tr], tests.loc[tr]).predict(Xc.loc[tr]), tr) for tr, te in train.rolling(tests, [7, 8, 9])])
print(f"1. Error on tests it learned from {seen:.1f}%, on the unseen next month {roll(Xc, [7, 8, 9]):.1f}%")
def base(kind):
    out = []
    for tr, te in train.rolling(tests, [7, 8, 9]):
        t = tests.loc[tr].sort_values("test_start").groupby("well_name")[PH]
        out.append((t.last() if kind == "last" else t.mean()).reindex(tests.loc[te, "well_name"]).set_index(te))
    P = pd.concat(out); return mape(P, P.index)
print(f"2. Baselines: last test {base('last'):.1f}%, well average {base('mean'):.1f}%")
rng = np.random.default_rng(0); shuf = []
for i in range(10):
    Xs = Xc.copy()
    for c in ["dh_pressure_psia", "gas_lift_rate_mscfd", "tubing_gradient"]:
        Xs[c] = Xc.groupby("well_name")[c].transform(lambda s: s.sample(frac=1, random_state=int(rng.integers(1e9))).values)
    shuf.append(roll(Xs, [7, 8, 9]))
print(f"3. Sensors shuffled within each well: {np.mean(shuf):.1f}% (worse, so the sensors carry real information)")
print("4. By month:", {m: round(float(roll(Xc, [m])), 1) for m in [4, 5, 6, 7, 8, 9]})
""")

md("""
## 4. Final model, saved as `models/vfm_model.pkl`

Fitted on all 85 well tests and saved together with its inputs, the wells it knows and its check results.
The web app loads this file to estimate rates for uploaded data.
""")
code("""
fit = PhysicsIPR(W).fit(predict.calibrated_input(X), tests)
path = predict.save_model(fit, train.model_card(tests, per_set, preds, best))
card = predict.load_model(path)
print(path.relative_to(path.parent.parent), "|", card["name"])
print("inputs:", card["inputs"])
print("trained on", card["trained_on_tests"], "tests,", card["trained_period"])
""")

md("## 5. Phase 1 result: daily oil, water and gas for every well")
code("""
daily = predict.predict_daily(card["model"], daily_in)
daily.to_csv("outputs/daily_rates.csv", index=False)
tests.to_csv("outputs/well_tests_clean.csv", index=False)
out = build_submission(daily)
sub = pd.read_csv(out)
print(f"{out.relative_to(out.parent.parent)}: {len(sub)} rows, {sub.well_name.nunique()} wells, "
      f"{sub.timestamp.min()} to {sub.timestamp.max()}")
sub.head()
""")
code("""
fig, axes = plt.subplots(3, 1, figsize=(12, 8), sharex=True)
w = "GL-07"; g = daily[daily.well_name == w]; t = tests[tests.well_name == w]
for ax, (col, tcol, lab, c) in zip(axes, [("oil_stbd", "oil_rate_stbd", "Oil STB/d", "#A2845E"),
                                          ("water_stbd", "water_rate_stbd", "Water STB/d", "#30B0C7"),
                                          ("formation_gas_mscfd", "gas_rate_mscfd", "Gas Mscf/d", "#FF9500")]):
    ax.plot(g.date, g[col], color=c, lw=1.3, label="estimated")
    ax.scatter(t.test_start, t[tcol], facecolor="white", edgecolor="black", zorder=3, label="well test")
    ax.set_ylabel(lab); ax.legend(loc="lower left", frameon=False)
axes[0].set_title(f"{w}: estimated daily rates against its well tests", loc="left");
""")
code("""
piv = daily.pivot_table(index="date", columns="well_name", values="oil_stbd")
ax = piv.plot.area(figsize=(12, 4), linewidth=0, title="Field oil rate by well, STB/d")
ax.legend(ncol=5, fontsize=8, frameon=False)
reports.per_well_summary(daily)
""")

md("""
## 6. Phase 2: build-up analysis

Each choke closure that is reopened is a build-up. For each one:

* `q` = predicted oil rate on the last fully flowing day before the shut-in (Phase 1).
* `tp` = cumulative predicted oil since 1 January / q.
* The radial-flow window is the flattest half log cycle of the Bourdet derivative after wellbore storage;
  the Horner slope `m` is fitted there.
* `k = 162.6 q Bo μ / (m h)`, `s = 1.151 [(P1hr − Pwf)/m − log(k/(φ μ ct rw²)) + 3.23]`, `ΔP skin = 0.87 m s`.

Only 6 shut-ins fall inside our data (January to September).
""")
code("""
pvt = pd.read_csv(DATA / "reservoir_pvt.csv").set_index("well_name")
table, web, skipped = pta.run(hf, daily, pvt)
(pta.ROOT / "outputs" / "pta_web.json").write_text(json.dumps(web))
table.drop(columns=["plot"]).to_csv(pta.RESULT.parent / "pta_results_detailed.csv", index=False)
print("Phase 2 result file:", pta.write_submission(table).relative_to(pta.ROOT))
table[["well_name", "t_shut", "q_pred_stbd", "m_psi_cycle", "k_md", "skin", "dP_skin",
       "interpretation"]].round(2)
""")
md("### Well-test plots (saved in `pta_plots/`)")
code("""
for p in web:
    display(Image(filename=str(pta.OUT / p["plot"]), width=950))
""")
md("### Interpretation")
code("""
for p in web:
    print(f"{p['well_name']} {p['t_shut']}: {p['interpretation'].upper()}")
    for n in p["notes"]:
        print("   -", n)
    print()
""")

md("## 7. Reports and the web app")
code("""
from export_web import export
src = "Hackathon field data"
print(reports.vfm_excel(daily, sub, card, pta.ROOT / "results" / "vfm_report.xlsx", src).name)
print(reports.vfm_pdf(daily, tests, card, pta.ROOT / "results" / "vfm_report.pdf", src).name)
print(reports.pta_pdf(web, pta.OUT, pta.ROOT / "results" / "pta_report.pdf", src).name)
print(export().name, "(web app data)")
""")
md("""
**Deliverables**

| What | Where |
|---|---|
| Phase 1 result file | `results/vfm_submission.csv` |
| Phase 2 result file | `results/pta_submission.csv` |
| Trained model | `models/vfm_model.pkl` |
| PTA plots | `pta_plots/` |
| Reports | `results/vfm_report.xlsx`, `results/vfm_report.pdf`, `results/pta_report.pdf` |
| Web app | `python3 app.py`, then open http://127.0.0.1:8000 |
""")

nb = nbf.v4.new_notebook(cells=cells, metadata={"kernelspec": {"name": "python3", "display_name": "Python 3", "language": "python"}})
nbf.write(nb, ROOT / "notebook.ipynb")
print("Wrote", ROOT / "notebook.ipynb")
