"""Well-calibrated physics model (adapted from the CHIRAG_VFM_model_and_code package).

Instead of one formula for all wells, every well gets its own numbers, learned from its own well tests:
  Liquid rate  q_L = a_w + b_w * P_downhole + c_w * days   (+ shared gas-lift rate and tubing gradient)
               -> a per-well inflow line (IPR) that slowly drifts with depletion
  Water cut    WC  = level_w + trend_w * days              (+ shared tubing gradient)
  Oil = q_L * (1 - WC),  Water = q_L * WC,  Gas = Oil * GOR_w  (GOR_w = average GOR of that well's tests;
  for a well with no tests it falls back to the solution GOR from reservoir_pvt.csv)

Inputs are still only sensors + fixed well data; well-test results are only used as training labels.
Limit: it needs a well's own tests, so it is not meant for a brand-new well.
"""
import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import RidgeCV
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

START = pd.Timestamp("2025-01-01")
SHARED_LIQ = ["dh_pressure_psia", "gas_lift_rate_mscfd", "days", "tubing_gradient"]
SHARED_WC = ["days", "tubing_gradient"]
INPUTS = ["well_name", "dh_pressure_psia", "gas_lift_rate_mscfd", "days", "tubing_gradient",
          "solution_gor_at_pb_scf_stb"]


def ridge():
    return make_pipeline(SimpleImputer(), StandardScaler(), RidgeCV(alphas=np.logspace(-3, 3, 25)))


class PhysicsIPR:
    def __init__(self, wells):
        self.wells = list(wells)

    def _X(self, d: pd.DataFrame):
        X = {}
        for w in self.wells:
            on = (d.well_name == w).astype(float)
            X[f"w_{w}"] = on                                  # well's own level
            X[f"pwf_{w}"] = on * d.dh_pressure_psia           # well's own pressure response (IPR slope)
            X[f"t_{w}"] = on * d.days                         # well's own time trend
        X = pd.DataFrame(X, index=d.index)
        own = list(X.columns)
        liq = pd.concat([d[SHARED_LIQ], X], axis=1)
        wc = pd.concat([d[SHARED_WC], X[[c for c in own if not c.startswith("pwf_")]]], axis=1)
        return liq, wc

    def fit(self, d: pd.DataFrame, tests: pd.DataFrame):
        liq, wc = self._X(d)
        self.m_liq = ridge().fit(liq, tests.liquid_rate_stbd)
        self.m_wc = ridge().fit(wc, tests.water_cut_pct)
        self.gor = (tests.gas_rate_mscfd * 1000 / tests.oil_rate_stbd).groupby(tests.well_name).mean()
        return self

    def predict(self, d: pd.DataFrame) -> pd.DataFrame:
        liq_X, wc_X = self._X(d)
        liq = np.clip(self.m_liq.predict(liq_X), 0, None)
        wc = np.clip(self.m_wc.predict(wc_X), 0, 100) / 100
        gor = d.well_name.map(self.gor).fillna(d.solution_gor_at_pb_scf_stb).to_numpy()
        oil = liq * (1 - wc)
        return pd.DataFrame({"oil_rate_stbd": oil, "water_rate_stbd": liq * wc,
                             "gas_rate_mscfd": oil * gor / 1000}, index=d.index)
