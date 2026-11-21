"""Build the data the web app shows, from pipeline outputs.

build_data() is used by the web app for uploaded data; export() writes web/data.js for the
hackathon data, so web/index.html also works when opened straight from disk.
Run from repo root:  python3 src/export_web.py   (train.py and pta.py also call this)
"""
import json
from datetime import datetime
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "outputs"
WEB = ROOT / "web"
MODEL = ROOT / "models" / "vfm_model.pkl"


def r(x, nd=1):
    return None if x is None or pd.isna(x) else round(float(x), nd)


# Daily sensor averages (flowing minutes only) shown on the Plot page: key in data -> column
SENSOR_KEYS = {"bhp": "dh_pressure_psia", "whp": "whp_psia", "whp_dn": "whp_downstream_psia",
               "ann": "annulus_pressure_psia", "bht": "dh_temperature_degf", "choke": "choke_opening_pct"}
# Well-test values shown on the Plot page: key in data -> column of the cleaned well tests
TEST_KEYS = {"oil": "oil_rate_stbd", "water": "water_rate_stbd", "gas": "gas_rate_mscfd",
             "total": "total_gas_rate_mscfd", "liquid": "liquid_rate_stbd", "wc": "water_cut_pct",
             "gor": "gor_scf_stb", "lift": "gas_lift_rate_mscfd", "whp": "whp_psia", "bhp": "dh_pressure_psia",
             "bht": "dh_temperature_degf", "ann": "annulus_pressure_psia"}


def well_info(static: pd.DataFrame | None) -> dict:
    """Manifold, oil produced before 2025 and a volumetric oil-in-place estimate per well.

    OOIP = 7758 * area * net pay * porosity * (1 - Sw) / Bo   (STB; drainage area in acres)
    """
    if static is None:
        return {}
    info = {}
    for row in static.itertuples():
        g = row._asdict()
        ooip = None
        need = ["estimated_drainage_area_acres", "net_pay_thickness_ft", "porosity_frac",
                "water_saturation_frac", "oil_fvf_rb_stb"]
        if all(k in g and pd.notna(g[k]) for k in need):
            ooip = (7758 * g["estimated_drainage_area_acres"] * g["net_pay_thickness_ft"] * g["porosity_frac"]
                    * (1 - g["water_saturation_frac"]) / g["oil_fvf_rb_stb"])
        info[row.well_name] = {"manifold": g.get("production_manifold"), "cum0": r(g.get("cum_oil_at_2025_01_01_stb"), 0),
                               "ooip": r(ooip, 0), "first": g.get("first_production_date")}
    return info


def build_data(daily: pd.DataFrame, tests: pd.DataFrame | None, card: dict, pta: list,
               source: dict, check: list | None = None, sensors: pd.DataFrame | None = None,
               static: pd.DataFrame | None = None) -> dict:
    """daily: predict_daily() output; tests: cleaned well tests (or None); card: the saved model's metadata.
    sensors: daily_features() output (daily sensor averages); static: completion + PVT. Both optional."""
    if sensors is not None:
        cols = [c for c in SENSOR_KEYS.values() if c in sensors]
        daily = daily.merge(sensors[["well_name", "date", *cols]], on=["well_name", "date"], how="left")
    wells = {}
    for w, g in daily.sort_values("date").groupby("well_name"):
        wells[w] = {
            "date": g.date.dt.strftime("%Y-%m-%d").tolist(),
            "oil": [r(v) for v in g.oil_stbd], "water": [r(v) for v in g.water_stbd],
            "gas": [r(v) for v in g.formation_gas_mscfd], "lift": [r(v) for v in g.gas_lift_mscfd],
            "total": [r(v) for v in g.total_gas_mscfd], "uptime": [r(v, 3) for v in g.uptime],
        }
        for key, col in SENSOR_KEYS.items():
            if col in g:
                wells[w][key] = [r(v) for v in g[col]]
    well_tests = {}
    if tests is not None:
        keys = {k: c for k, c in TEST_KEYS.items() if c in tests}
        well_tests = {w: [{"t": row["test_start"].strftime("%Y-%m-%d %H:%M"),
                           **{k: r(row[c]) for k, c in keys.items()}} for _, row in g.iterrows()]
                      for w, g in tests.sort_values("test_start").groupby("well_name")}
    return {
        "generated": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "source": source,
        "wells": wells,
        "tests": well_tests,
        "selection": [{k: (r(v) if isinstance(v, float) else v) for k, v in row.items()} for row in card["selection"]],
        "best": {**card["best"], "mape": r(card["best"]["mape"])},
        "final": [{"well": x["well_name"], "phase": x["phase"], "t": x["test_start"][:10],
                   "measured": r(x["measured"]), "predicted": r(x["predicted"])} for x in card["final_check"]],
        "lowoBest": r(card["leave_one_well_out_best_mape"]),
        "model": {"name": card["name"], "wells": card["wells"], "trained_on_tests": card["trained_on_tests"],
                  "trained_period": card["trained_period"], "created": card["created"]},
        "check": check or [],      # uploaded well tests vs the model, when the upload has well tests
        "pta": pta,
        "info": well_info(static),
    }


def export() -> Path:
    import sys
    sys.path.insert(0, str(Path(__file__).parent))
    from data import load_high_freq, load_static
    from features import daily_features
    from predict import load_model

    daily = pd.read_csv(OUT / "daily_rates.csv", parse_dates=["date"])
    tests = pd.read_csv(OUT / "well_tests_clean.csv", parse_dates=["test_start"])
    pta = json.loads((OUT / "pta_web.json").read_text()) if (OUT / "pta_web.json").exists() else []
    static = load_static()
    try:  # daily sensor averages for the Plot page; skipped if the raw sensor data is not on this computer
        sensors = daily_features(load_high_freq(), static)
    except FileNotFoundError:
        sensors = None
    data = build_data(daily, tests, load_model(MODEL), pta,
                      source={"id": "sample", "name": "Hackathon field data", "files": [], "warnings": []},
                      sensors=sensors, static=static)
    WEB.mkdir(exist_ok=True)
    path = WEB / "data.js"
    path.write_text("// Generated by src/export_web.py. Do not edit.\nwindow.VFM_DATA = "
                    + json.dumps(data, separators=(",", ":")) + ";\n")
    return path


if __name__ == "__main__":
    print(f"Wrote {export()}")
