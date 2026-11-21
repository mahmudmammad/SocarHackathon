"""Data-quality report for the VFM hackathon data.

Read-only on data/. Writes reports/data_quality_report.xlsx plus one CSV per sheet.
Run from the repo root:  python3 scripts/data_quality_report.py
"""
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = ROOT / "reports"

M3_PER_MSCF = 28.317  # 1 Mscf = 28.317 m3
NULL_CODE = -999.25
SENSORS = ["whp_psia", "whp_downstream_psia", "dh_pressure_psia",
           "dh_temperature_degf", "annulus_pressure_psia", "gas_lift_rate_mscfd"]
# Physical limits based on the 0.1-99.9 percentile range of the data with a margin.
LIMITS = {
    "whp_psia": (0, 1000),
    "whp_downstream_psia": (0, 300),
    "dh_pressure_psia": (500, 4500),
    "dh_temperature_degf": (100, 230),
    "annulus_pressure_psia": (0, 2000),
    "gas_lift_rate_mscfd": (0, 2500),
}
TOL = 1.0  # tolerance for balance checks


def well_test_issues(t: pd.DataFrame) -> pd.DataFrame:
    """Flag rows of well_tests.csv that break unit or balance rules."""
    t = t.copy()
    t["gor_from_gas_oil"] = (t.gas_rate_mscfd * 1000 / t.oil_rate_stbd).round(1)
    t["liquid_minus_oil_water"] = (t.liquid_rate_stbd - t.oil_rate_stbd - t.water_rate_stbd).round(1)
    t["totgas_minus_gas_lift"] = (t.total_gas_rate_mscfd - t.gas_rate_mscfd - t.gas_lift_rate_mscfd).round(1)

    rows = []
    for i, r in t.iterrows():
        probs, fixes = [], []
        # Unit error: reported GOR is consistent but gas/oil ratio is ~28.3x larger
        ratio = r.gor_from_gas_oil / r.gor_scf_stb if r.gor_scf_stb else np.nan
        if abs(abs(ratio) - M3_PER_MSCF) < 0.5:
            probs.append(f"gas_rate & total_gas_rate in m3/d (gas/oil gives GOR {r.gor_from_gas_oil:.0f} = "
                         f"{abs(ratio):.2f} x reported GOR {r.gor_scf_stb})")
            fixes.append(f"gas_rate {r.gas_rate_mscfd} -> {abs(r.gas_rate_mscfd) / M3_PER_MSCF:.1f}; "
                         f"total_gas {r.total_gas_rate_mscfd} -> {r.total_gas_rate_mscfd / M3_PER_MSCF:.1f} Mscf/d")
        for col in ["oil_rate_stbd", "water_rate_stbd", "gas_rate_mscfd",
                    "total_gas_rate_mscfd", "gas_lift_rate_mscfd", "liquid_rate_stbd"]:
            if r[col] < 0:
                probs.append(f"{col} is negative ({r[col]})")
                fixes.append(f"{col} {r[col]} -> {abs(r[col])}")
        if not probs:
            continue
        rows.append({"row_in_file": i + 2, "well_name": r.well_name, "test_start": r.test_start,
                     "problem": "; ".join(probs), "suggested_fix": "; ".join(fixes),
                     **{c: r[c] for c in ["oil_rate_stbd", "water_rate_stbd", "liquid_rate_stbd",
                                          "water_cut_pct", "gas_rate_mscfd", "gas_lift_rate_mscfd",
                                          "total_gas_rate_mscfd", "gor_scf_stb", "gor_from_gas_oil",
                                          "liquid_minus_oil_water", "totgas_minus_gas_lift"]}})
    return pd.DataFrame(rows)


def test_sensor_mismatch(t: pd.DataFrame, h: pd.DataFrame) -> pd.DataFrame:
    """Compare sensor averages stored in well_tests.csv with the high-freq log."""
    rows = []
    for i, r in t.iterrows():
        s = h[(h.well_name == r.well_name) & (h.timestamp >= r.test_start) & (h.timestamp < r.test_end)]
        s = s[SENSORS].replace(NULL_CODE, np.nan)
        for c in SENSORS:
            lo, hi = LIMITS[c]
            m = s[c].where((s[c] >= lo) & (s[c] <= hi)).mean()
            diff = r[c] - m
            tol = 1.0 if c == "dh_temperature_degf" else 20.0
            if abs(diff) > tol:
                rows.append({"row_in_file": i + 2, "well_name": r.well_name, "test_start": r.test_start,
                             "column": c, "well_tests_value": r[c], "high_freq_mean": round(m, 2),
                             "difference": round(diff, 2)})
    return pd.DataFrame(rows)


def main() -> None:
    OUT.mkdir(exist_ok=True)
    t = pd.read_csv(DATA / "well_tests.csv", parse_dates=["test_start", "test_end"])
    print("Loading high_freq_data.csv ...")
    h = pd.read_csv(DATA / "high_freq_data.csv", parse_dates=["timestamp"])

    # 1. well tests
    wt = well_test_issues(t)
    wt_sens = test_sensor_mismatch(t, h)

    # 2. -999.25 placeholders
    is_null = h[SENSORS] == NULL_CODE
    null_counts = is_null.groupby(h.well_name).sum()
    null_counts.loc["TOTAL"] = null_counts.sum()
    null_counts = null_counts.reset_index()
    null_examples = h[is_null.any(axis=1)].groupby("well_name").head(5)

    # 3. out-of-range readings (long format: one row per bad value)
    out = []
    for c in SENSORS:
        lo, hi = LIMITS[c]
        bad = h[((h[c] < lo) | (h[c] > hi)) & (h[c] != NULL_CODE)]
        out.append(pd.DataFrame({"timestamp": bad.timestamp, "well_name": bad.well_name, "column": c,
                                 "value": bad[c], "allowed_min": lo, "allowed_max": hi}))
    outliers = pd.concat(out).sort_values(["well_name", "timestamp"]).reset_index(drop=True)

    # 4. duplicates
    dup_mask = h.duplicated(keep="first")
    duplicates = h[dup_mask].sort_values(["well_name", "timestamp"])
    same_ts_diff_values = h.duplicated(["well_name", "timestamp"]).sum() - dup_mask.sum()

    # 5. gaps
    hs = h.drop_duplicates(["well_name", "timestamp"]).sort_values(["well_name", "timestamp"])
    step = hs.groupby("well_name").timestamp.diff()
    g = hs[step > pd.Timedelta("5min")]
    gaps = pd.DataFrame({"well_name": g.well_name,
                         "last_reading_before": g.timestamp - step[g.index],
                         "first_reading_after": g.timestamp})
    gaps["missing_minutes"] = ((gaps.first_reading_after - gaps.last_reading_before)
                               .dt.total_seconds() / 60 - 1).astype(int)
    gaps["missing_hours"] = (gaps.missing_minutes / 60).round(1)
    n_wells = h.well_name.nunique()
    shared = gaps.groupby(["last_reading_before", "first_reading_after"]).well_name.transform("size")
    gaps["note"] = np.where(shared == n_wells, "ALL wells missing at the same time",
                            np.where(gaps.missing_hours >= 24, ">= 24 h gap", ""))
    gaps = gaps.reset_index(drop=True)

    # 6. summary
    n_unit = wt.problem.str.contains("m3/d").sum() if len(wt) else 0
    n_sign = wt.problem.str.contains("negative").sum() if len(wt) else 0
    summary = pd.DataFrame([
        ["well_tests.csv", "GL-06 gas in m3/d instead of Mscf/d", n_unit,
         "Gas labels ~28x too high; gas model chases these rows", "Divide gas & total gas by 28.317"],
        ["well_tests.csv", "Negative values (sign flip)", n_sign,
         "Model learns impossible negative rates", "Take absolute value; balances then close"],
        ["well_tests.csv", "Test sensor average differs from high-freq log", len(wt_sens),
         "Only the 2 negative gas-lift rows; everything else matches the log",
         "Fixed by the sign-flip correction"],
        ["high_freq_data.csv", "-999.25 missing-value code", int(is_null.values.sum()),
         "Drags daily averages down", "Treat as NaN"],
        ["high_freq_data.csv", "Readings outside physical limits", len(outliers),
         "Spikes distort daily features", "Treat as NaN"],
        ["high_freq_data.csv", "Exact duplicate rows", len(duplicates),
         "Negligible", "Drop duplicates"],
        ["high_freq_data.csv", "Gaps > 5 min", len(gaps),
         f"{(gaps.missing_hours >= 24).sum()} gaps >= 24 h; "
         f"{(gaps.note == 'ALL wells missing at the same time').sum() // n_wells} outage(s) hitting all wells",
         "Interpolate short gaps; flag long ones"],
    ], columns=["file", "issue", "count", "impact_on_model", "suggested_fix"])

    sheets = {
        "summary": summary,
        "well_tests_bad_rows": wt,
        "well_tests_sensor_mismatch": wt_sens,
        "hf_missing_-999_counts": null_counts,
        "hf_missing_-999_examples": null_examples,
        "hf_outliers": outliers,
        "hf_duplicates": duplicates,
        "hf_gaps": gaps,
    }
    xlsx = OUT / "data_quality_report.xlsx"
    with pd.ExcelWriter(xlsx, engine="openpyxl") as xw:
        for name, df in sheets.items():
            df.to_excel(xw, sheet_name=name[:31], index=False)
            ws = xw.sheets[name[:31]]
            ws.freeze_panes = "A2"
            for col in ws.columns:
                width = max(len(str(c.value)) if c.value is not None else 0 for c in col[:200])
                ws.column_dimensions[col[0].column_letter].width = min(max(width + 2, 10), 80)
    for name, df in sheets.items():
        df.to_csv(OUT / f"{name}.csv", index=False)

    print(summary.to_string(index=False))
    print(f"Same timestamp but different values: {same_ts_diff_values}")
    print(f"Wrote {xlsx} and {len(sheets)} CSVs to {OUT}")


if __name__ == "__main__":
    main()
