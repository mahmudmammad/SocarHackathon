"""Feature building. Only live sensors + fixed well properties are ever used as inputs."""
import numpy as np
import pandas as pd

from data import SENSORS

# --- Feature sets for the ablation -------------------------------------------
# Downstream WHP (and choke dP) are left out on purpose: during well tests the well flows to
# the test separator, so downstream pressure is ~25 psi lower than in normal production.
# It reflects routing, not flow, and makes the model extrapolate on production days.
STRICT = [  # pressure, temperature, choke only (exactly the brief)
    "whp_psia", "dh_pressure_psia", "dh_temperature_degf",
    "choke_opening_pct", "dp_tubing", "gilbert_term",
]
GASLIFT = STRICT + ["annulus_pressure_psia", "gas_lift_rate_mscfd", "dp_annulus_tubing"]
WELLPROPS = GASLIFT + [
    "gauge_tvd_ft", "gl_valve_tvd_ft", "tubing_id_in", "oil_fvf_rb_stb", "oil_viscosity_cp",
    "bubble_point_pressure_psia", "solution_gor_at_pb_scf_stb", "net_pay_thickness_ft",
    "tubing_gradient",
]
FEATURE_SETS = {"1_strict": STRICT, "2_plus_gaslift": GASLIFT, "3_plus_well_props": WELLPROPS}
# Set 4 is used by the well-calibrated model in vfm_model.py (own numbers per well + time trend).
CALIBRATED_SET = "4_well_calibrated"
CALIBRATED = ["dh_pressure_psia", "gas_lift_rate_mscfd", "days", "tubing_gradient", "solution_gor_at_pb_scf_stb"]
START = pd.Timestamp("2025-01-01")

# Columns from well_tests.csv that must never be model inputs.
FORBIDDEN = {"oil_rate_stbd", "water_rate_stbd", "gas_rate_mscfd", "total_gas_rate_mscfd",
             "liquid_rate_stbd", "water_cut_pct", "gor_scf_stb", "glr_scf_stb", "bsw_pct",
             "separator_pressure_psia", "separator_temperature_degf", "oil_gravity_api",
             "gas_sg", "water_salinity_ppm"}
for _s in [*FEATURE_SETS.values(), CALIBRATED]:
    assert not FORBIDDEN & set(_s), "well-test result column used as feature"


def add_derived(df: pd.DataFrame, static: pd.DataFrame) -> pd.DataFrame:
    """Add physics-motivated features to a frame of averaged sensor values."""
    df = df.merge(static, on="well_name", how="left")
    df["dp_choke"] = df.whp_psia - df.whp_downstream_psia
    df["dp_tubing"] = df.dh_pressure_psia - df.whp_psia
    # Gilbert choke relation: q ~ WHP * S^1.89 (S = bean size, proportional to choke %)
    df["gilbert_term"] = df.whp_psia * (df.choke_opening_pct / 100 * 128) ** 1.89 / 1e4
    df["dp_annulus_tubing"] = df.annulus_pressure_psia - df.whp_psia
    df["tubing_gradient"] = df.dp_tubing / df.gauge_tvd_ft  # psi/ft -> mixture density
    return df


def window_features(hf: pd.DataFrame, tests: pd.DataFrame, static: pd.DataFrame) -> pd.DataFrame:
    """Average sensors over each well test window (flowing minutes only)."""
    rows = []
    cols = SENSORS + ["choke_opening_pct"]
    for well, g in hf.groupby("well_name"):
        ts = g.timestamp.values
        for idx, r in tests[tests.well_name == well].iterrows():
            a, b = np.searchsorted(ts, [np.datetime64(r.test_start), np.datetime64(r.test_end)])
            w = g.iloc[a:b]
            w = w[w.choke_opening_pct > 0]
            mid = r.test_start + (r.test_end - r.test_start) / 2
            rows.append({"test_idx": idx, "well_name": well, "days": (mid - START) / pd.Timedelta("1D"),
                         **w[cols].mean().to_dict()})
    feats = pd.DataFrame(rows).set_index("test_idx").sort_index()
    return add_derived(feats.reset_index(), static).set_index("test_idx")


def daily_features(hf: pd.DataFrame, static: pd.DataFrame) -> pd.DataFrame:
    """Per well-day: sensor means over flowing minutes + uptime fraction."""
    hf = hf.assign(date=hf.timestamp.dt.normalize(), flowing=hf.choke_opening_pct > 0)
    cols = SENSORS + ["choke_opening_pct"]
    means = hf[hf.flowing].groupby(["well_name", "date"])[cols].mean()
    # Uptime = share of the LOGGED minutes with the choke open. Sensor gaps are not shut-ins
    # (the choke stays open), so dividing by 1440 would wrongly scale those days down.
    minutes = hf.groupby(["well_name", "date"]).size().rename("minutes_logged")
    uptime = hf.groupby(["well_name", "date"]).flowing.sum().div(minutes).clip(upper=1).rename("uptime")
    d = pd.concat([uptime, minutes, means], axis=1).reset_index()
    d["days"] = (d.date + pd.Timedelta("12h") - START) / pd.Timedelta("1D")  # middle of the day
    return add_derived(d, static)
