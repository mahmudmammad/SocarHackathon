"""Load and clean the hackathon data. Raw CSVs in data/ are never modified."""
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE = ROOT / "cache"

M3_PER_MSCF = 28.317
NULL_CODE = -999.25
SENSORS = ["whp_psia", "whp_downstream_psia", "dh_pressure_psia",
           "dh_temperature_degf", "annulus_pressure_psia", "gas_lift_rate_mscfd"]
LIMITS = {
    "whp_psia": (0, 1000),
    "whp_downstream_psia": (0, 300),
    "dh_pressure_psia": (500, 4500),
    "dh_temperature_degf": (100, 230),
    "annulus_pressure_psia": (0, 2000),
    "gas_lift_rate_mscfd": (0, 2500),
}
RATE_COLS = ["oil_rate_stbd", "water_rate_stbd", "liquid_rate_stbd", "gas_rate_mscfd",
             "total_gas_rate_mscfd", "gas_lift_rate_mscfd"]


def load_high_freq() -> pd.DataFrame:
    """1-min sensors, cleaned, with choke % attached. Cached as parquet."""
    CACHE.mkdir(exist_ok=True)
    cached = CACHE / "high_freq_clean.parquet"
    if cached.exists():
        return pd.read_parquet(cached)

    src = DATA / "high_freq_data.csv"
    if not src.exists():  # the repo ships the 272 MB file zipped (GitHub's limit is 100 MB)
        src = DATA / "high_freq_data.zip"
    h = clean_high_freq(pd.read_csv(src, parse_dates=["timestamp"]),
                        pd.read_csv(DATA / "choke_events.csv", parse_dates=["timestamp"]))
    h.to_parquet(cached)
    return h


def clean_high_freq(h: pd.DataFrame, choke: pd.DataFrame) -> pd.DataFrame:
    """Drop duplicate minutes, blank out -999.25 codes and impossible values, attach choke %."""
    h = h.drop_duplicates(["well_name", "timestamp"]).copy()
    for c in SENSORS:
        lo, hi = LIMITS[c]
        h[c] = h[c].where((h[c] != NULL_CODE) & h[c].between(lo, hi))
    h = pd.merge_asof(h.sort_values("timestamp"), choke.sort_values("timestamp"),
                      on="timestamp", by="well_name", direction="backward")
    return h.sort_values(["well_name", "timestamp"]).reset_index(drop=True)


def load_well_tests() -> pd.DataFrame:
    """Well tests with the GL-06 unit error and sign flips corrected."""
    return clean_well_tests(pd.read_csv(DATA / "well_tests.csv", parse_dates=["test_start", "test_end"]))


def clean_well_tests(t: pd.DataFrame) -> pd.DataFrame:
    t = t.copy()
    t[RATE_COLS] = t[RATE_COLS].abs()
    gor_calc = t.gas_rate_mscfd * 1000 / t.oil_rate_stbd
    in_m3 = (gor_calc / t.gor_scf_stb - M3_PER_MSCF).abs() < 0.5
    t.loc[in_m3, ["gas_rate_mscfd", "total_gas_rate_mscfd"]] /= M3_PER_MSCF
    t["water_cut_pct"] = 100 * t.water_rate_stbd / t.liquid_rate_stbd
    return t


def load_static() -> pd.DataFrame:
    """Fixed per-well properties (completion + PVT). pta_results.csv is not used."""
    comp = pd.read_csv(DATA / "well_completion.csv")
    pvt = pd.read_csv(DATA / "reservoir_pvt.csv")
    return comp.merge(pvt, on="well_name")
