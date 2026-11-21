"""Run the whole workflow on uploaded raw well data (used by the web app, app.py).

Files are recognised by their columns, not their names:
  sensors       timestamp, well_name, whp_psia, dh_pressure_psia, ...   (required)
  choke events  timestamp, well_name, choke_opening_pct                  (required)
  completion    well_name, gauge_tvd_ft, ...      (optional, falls back to the bundled file)
  reservoir PVT well_name, porosity_frac, ...     (optional, falls back to the bundled file)
  well tests    well_name, test_start, test_end, oil_rate_stbd, ...   (optional: checks the model,
                                                                        or recalibrates it if asked)
  PTA answer key well_name, t_shut, k_md, ...     (optional, only shown next to our results)

Steps: clean sensors -> daily averages -> VFM model (.pkl) -> daily rates -> build-up analysis
-> result files, reports and the data the web page shows.
"""
import json
import shutil
import zipfile
from pathlib import Path

import pandas as pd

import pta
import reports
from data import DATA, clean_high_freq, clean_well_tests
from export_web import build_data
from features import daily_features, window_features
from predict import calibrated_input, load_model, predict_daily, save_model
from submission import build as build_submission
from vfm_model import PhysicsIPR

ROLES = [  # (role, columns that must be present), checked in this order
    ("sensors", {"timestamp", "well_name", "whp_psia", "dh_pressure_psia"}),
    ("well_tests", {"well_name", "test_start", "test_end", "oil_rate_stbd"}),
    ("answer_key", {"well_name", "t_shut", "k_md"}),
    ("choke", {"timestamp", "well_name", "choke_opening_pct"}),
    ("pvt", {"well_name", "porosity_frac", "oil_fvf_rb_stb"}),
    ("completion", {"well_name", "gauge_tvd_ft"}),
]
LABELS = {"sensors": "Sensor readings", "choke": "Choke events", "completion": "Well completion",
          "pvt": "Reservoir and fluid properties", "well_tests": "Well tests", "answer_key": "PTA answer key"}
SENSOR_COLS = ["dh_pressure_psia", "whp_psia", "annulus_pressure_psia", "gas_lift_rate_mscfd",
               "dh_temperature_degf", "choke_opening_pct", "whp_downstream_psia"]


def unpack(upload_dir: Path) -> list[Path]:
    """CSV files in the upload folder; zips are opened (flat, only .csv members)."""
    files = []
    for f in sorted(upload_dir.iterdir()):
        if f.suffix.lower() == ".zip":
            with zipfile.ZipFile(f) as z:
                for name in z.namelist():
                    base = Path(name).name
                    if base.lower().endswith(".csv") and not base.startswith("."):
                        target = upload_dir / base
                        with z.open(name) as src, open(target, "wb") as dst:
                            shutil.copyfileobj(src, dst)
                        files.append(target)
        elif f.suffix.lower() == ".csv":
            files.append(f)
    return sorted(set(files))


def identify(files: list[Path]) -> tuple[dict, list]:
    found, ignored = {}, []
    for f in files:
        try:
            cols = set(pd.read_csv(f, nrows=0).columns.str.strip())
        except Exception:
            ignored.append(f.name)
            continue
        role = next((r for r, need in ROLES if need <= cols), None)
        if role is None or role in found:
            ignored.append(f.name)
        else:
            found[role] = f
    return found, ignored


def hourly_sensors(hf: pd.DataFrame) -> pd.DataFrame:
    cols = [c for c in SENSOR_COLS if c in hf.columns]
    h = hf.assign(hour=hf.timestamp.dt.floor("h")).groupby(["well_name", "hour"])[cols].mean()
    return h.round(2).reset_index()


def run(job: Path, recalibrate: bool = False, progress=lambda step, text: None) -> dict:
    """Process job/upload/*. Writes job/results, job/pta_plots, job/data.json. Returns the data dict."""
    progress(1, "Reading the files")
    files = unpack(job / "upload")
    found, ignored = identify(files)
    warnings = []
    if "sensors" not in found:
        raise ValueError("No sensor file found. Upload the 1-minute data with timestamp, well_name, "
                         "whp_psia and dh_pressure_psia columns.")
    if "choke" not in found:
        raise ValueError("No choke events file found (timestamp, well_name, choke_opening_pct). "
                         "It is needed to know when each well was flowing or shut in.")
    for role, name in [("completion", "well_completion.csv"), ("pvt", "reservoir_pvt.csv")]:
        if role not in found:
            found[role] = DATA / name
            warnings.append(f"No {LABELS[role].lower()} file uploaded, so the bundled {name} was used.")
    if ignored:
        warnings.append("Not recognised, so not used: " + ", ".join(ignored) + ".")

    comp = pd.read_csv(found["completion"])
    pvt = pd.read_csv(found["pvt"])
    static = comp.merge(pvt, on="well_name")
    choke = pd.read_csv(found["choke"], parse_dates=["timestamp"])

    progress(2, "Cleaning the sensor data")
    raw = pd.read_csv(found["sensors"], parse_dates=["timestamp"])
    n_raw = len(raw)
    hf = clean_high_freq(raw, choke)
    del raw
    wells = sorted(hf.well_name.unique())
    no_static = [w for w in wells if w not in set(static.well_name)]
    if no_static:
        warnings.append(f"No completion or PVT data for {', '.join(no_static)}: their gauge depth and fluid "
                        "properties are filled with field averages and they get no build-up analysis.")

    progress(3, "Averaging each well-day")
    daily = daily_features(hf, static)

    progress(4, "Estimating oil, water and gas")
    card = load_model()
    model = card["model"]
    tests = None
    check = []
    recalibrated = False
    if "well_tests" in found:
        tests = clean_well_tests(pd.read_csv(found["well_tests"], parse_dates=["test_start", "test_end"]))
        tests = tests[tests.well_name.isin(wells)].reset_index(drop=True)
    if recalibrate and tests is not None and len(tests) >= 3:
        X = window_features(hf, tests, static)
        model = PhysicsIPR(sorted(set(model.wells) | set(tests.well_name))).fit(calibrated_input(X), tests)
        save_model(model, {**{k: v for k, v in card.items() if k != "model"},
                           "recalibrated_on_tests": len(tests)}, job / "results" / "vfm_model_recalibrated.pkl")
        recalibrated = True
        warnings.append(f"Model recalibrated on the {len(tests)} uploaded well tests. The comparison with "
                        "those tests is then not an independent check.")
    elif recalibrate:
        warnings.append("Recalibration needs at least 3 uploaded well tests, so the saved model was used.")
    unknown = [w for w in wells if w not in model.wells]
    if unknown:
        warnings.append(f"The model has never seen {', '.join(unknown)}. Their rates use only the shared terms "
                        "and can be far off; upload well tests and choose recalibrate to fix this.")
    if tests is not None and len(tests):
        X = window_features(hf, tests, static)
        P = model.predict(calibrated_input(X))
        for phase, col in [("oil", "oil_rate_stbd"), ("water", "water_rate_stbd"), ("gas", "gas_rate_mscfd")]:
            for i, row in tests.iterrows():
                if pd.notna(P.loc[i, col]) and row[col] > 0:
                    check.append({"well": row.well_name, "phase": phase, "t": f"{row.test_start:%Y-%m-%d}",
                                  "measured": round(float(row[col]), 1), "predicted": round(float(P.loc[i, col]), 1)})

    out = predict_daily(model, daily)
    res = job / "results"
    res.mkdir(parents=True, exist_ok=True)
    out.to_csv(res / "daily_rates.csv", index=False)
    build_submission(out, res / "vfm_submission.csv")
    hourly_sensors(hf).to_parquet(job / "sensors_hourly.parquet")

    progress(5, "Analysing the build-ups")
    key = None
    if "answer_key" in found:
        key = pd.read_csv(found["answer_key"], parse_dates=["t_shut"])
    table, web, skipped = pta.run(hf, out, pvt.set_index("well_name"), choke, job / "pta_plots", key=key)
    for s in skipped:
        warnings.append(f"Build-up {s['well_name']} {s['t_shut'][:16]} skipped: {s['reason']}.")
    if len(table):
        pta.write_submission(table, res / "pta_submission.csv")
        table.drop(columns=["plot"]).to_csv(res / "pta_results_detailed.csv", index=False)

    progress(6, "Writing reports")
    label = f"Uploaded data ({hf.timestamp.min():%d %b %Y} to {hf.timestamp.max():%d %b %Y})"
    sub = pd.read_csv(res / "vfm_submission.csv")
    reports.vfm_excel(out, sub, card, res / "vfm_report.xlsx", label)
    reports.vfm_pdf(out, tests, card, res / "vfm_report.pdf", label)
    reports.pta_pdf(web, job / "pta_plots", res / "pta_report.pdf", label)

    source = {"id": job.name, "name": label, "warnings": warnings,
              "files": [{"role": LABELS[r], "name": Path(f).name, "bundled": Path(f).parent == DATA}
                        for r, f in found.items()],
              "rows": n_raw, "wells": wells, "recalibrated": recalibrated, "has_key": key is not None}
    data = build_data(out, tests, card, web, source, check)
    (job / "data.json").write_text(json.dumps(data, separators=(",", ":")))
    return data
