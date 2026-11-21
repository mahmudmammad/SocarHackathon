"""Write the Phase 1 result file in the format of data/vfm_submission_template.csv.

Columns (from the template): timestamp, well_name, oil_rate_stbd, water_rate_stbd, gas_rate_mscfd
- One row per well per day (2025-01-01 to 2025-09-30 for the hackathon data), from outputs/daily_rates.csv.
- Written to results/vfm_submission.csv.
- gas_rate_mscfd is formation gas (without injected lift gas), matching well_tests.csv.
- Rates are daily averages: days with a shut-in are scaled by the hours flowing; fully shut-in days are 0.
- Days with no sensor data at all (GL-06 on 2025-06-24) are filled by linear interpolation in time.

Run from repo root:  python3 src/submission.py   (train.py also calls this at the end)
"""
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "data" / "vfm_submission_template.csv"
OUT = ROOT / "results" / "vfm_submission.csv"
RATES = {"oil_stbd": "oil_rate_stbd", "water_stbd": "water_rate_stbd", "formation_gas_mscfd": "gas_rate_mscfd"}


def build(daily: pd.DataFrame | None = None, out: Path = OUT) -> Path:
    columns = pd.read_csv(TEMPLATE, nrows=0).columns.tolist()
    if daily is None:
        daily = pd.read_csv(ROOT / "outputs" / "daily_rates.csv", parse_dates=["date"])
    days = pd.date_range(daily.date.min(), daily.date.max(), freq="D")

    parts, filled = [], []
    for well, g in daily.groupby("well_name"):
        g = g.set_index("date").reindex(days)
        missing = g.index[g.oil_stbd.isna()]
        filled += [(well, d.date()) for d in missing]
        g[list(RATES)] = g[list(RATES)].interpolate(method="time", limit_direction="both")
        g = g.assign(well_name=well).rename_axis("date").reset_index()
        parts.append(g)
    sub = pd.concat(parts).rename(columns=RATES)
    sub["timestamp"] = sub.date.dt.strftime("%Y-%m-%d %H:%M:%S")
    sub = sub[columns].sort_values(["well_name", "timestamp"]).reset_index(drop=True)
    sub[list(RATES.values())] = sub[list(RATES.values())].round(1)

    assert sub.notna().all().all(), "empty values in submission"
    assert (sub[list(RATES.values())] >= 0).all().all(), "negative rates in submission"
    assert not sub.duplicated(["timestamp", "well_name"]).any(), "duplicate well-days"
    out.parent.mkdir(parents=True, exist_ok=True)
    sub.to_csv(out, index=False)
    if filled:
        print("Filled by interpolation (no sensor data that day):", ", ".join(f"{w} {d}" for w, d in filled))
    return out


if __name__ == "__main__":
    path = build()
    print(f"Wrote {path}")
