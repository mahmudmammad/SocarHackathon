"""Use the trained VFM model: save/load the .pkl and turn daily sensor averages into daily rates.

Shared by src/train.py (hackathon data), the notebook and the web app (uploaded data).
"""
import pickle
from pathlib import Path

import numpy as np
import pandas as pd

from data import ROOT
from features import CALIBRATED

MODEL_PATH = ROOT / "models" / "vfm_model.pkl"


def save_model(model, meta: dict, path: Path = MODEL_PATH) -> Path:
    """Pickle the fitted model with what it needs to be used and judged (inputs, wells, accuracy)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        pickle.dump({"model": model, **meta}, f)
    return path


def load_model(path: Path = MODEL_PATH) -> dict:
    with open(path, "rb") as f:
        return pickle.load(f)


def calibrated_input(X: pd.DataFrame) -> pd.DataFrame:
    return X[["well_name"] + CALIBRATED]


def predict_daily(model, daily: pd.DataFrame) -> pd.DataFrame:
    """Daily oil/water/gas per well from daily_features() output, using the well-calibrated model.

    A sensor missing for a whole flowing day is filled with the well's last good value.
    Rates are prorated by the share of the day the well was flowing; shut-in days are 0.
    """
    cols = CALIBRATED
    flowing = daily[cols].notna().any(axis=1) & (daily.uptime > 0)
    inp = calibrated_input(daily).copy()
    inp[cols] = inp.groupby("well_name")[cols].ffill().fillna(inp.groupby("well_name")[cols].bfill())
    P = model.predict(inp)

    out = daily[["well_name", "date", "uptime", "minutes_logged"]].copy()
    names = {"oil_rate_stbd": "oil_stbd", "water_rate_stbd": "water_stbd", "gas_rate_mscfd": "formation_gas_mscfd"}
    for src, dst in names.items():
        out[dst] = (np.where(flowing, P[src], 0.0) * daily.uptime).round(1)
    out["gas_lift_mscfd"] = (daily.gas_lift_rate_mscfd * daily.uptime).round(1)
    out["total_gas_mscfd"] = out.formation_gas_mscfd + out.gas_lift_mscfd
    out["water_cut_pct"] = (100 * out.water_stbd / (out.oil_stbd + out.water_stbd)).round(1)
    return out
