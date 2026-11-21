"""Phase 2: build-up (pressure transient) analysis using the PREDICTED daily oil rate.

Single-phase oil, Horner method, field units.
  Rate before shut-in  q  = predicted daily oil rate on the last fully-flowing day before the shut-in
  Producing time       tp = cumulative predicted oil (from 1 Jan 2025) / q, in hours
  Pressure             downhole gauge, 1-min data during the shut-in
  Radial-flow window   flattest half log cycle of the Bourdet derivative (after 30 min of wellbore
                       storage). EXTEND_WINDOW = True widens it to every neighbouring point within 10%
                       of that flat level (the whole plateau).
  m   = Horner slope (psi/cycle) from a straight-line fit of Pws vs log10((tp+dt)/dt) in that window
  k   = 162.6 q Bo mu / (m h)
  s   = 1.151 [ (P1hr - Pwf)/m - log10(k / (phi mu ct rw^2)) + 3.23 ]
  dPs = 0.87 m s

pta_results.csv (the organisers' interpretation) is read ONLY at the end, as an answer key for comparison.

Run from repo root:  python3 src/pta.py   (needs outputs/daily_rates.csv from src/train.py)
"""
import json

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from data import DATA, ROOT, load_high_freq
from export_web import export as export_web

OUT = ROOT / "pta_plots"                    # PNG per build-up (deliverable folder)
RESULT = ROOT / "results" / "pta_submission.csv"
LN10 = np.log(10)
DERIV_L = 0.15          # Bourdet smoothing, log cycles each side
WINDOW_CYCLES = 0.5     # width of radial-flow window, log cycles
MIN_START_H = 0.5       # ignore the first 30 min (wellbore storage)
PLATEAU_TOL = 0.10      # radial flow = derivative within 10% of its flat level
EXTEND_WINDOW = False   # True = widen to the whole flat plateau ("v2"). v1 scored better, so it is off


def shut_ins(choke: pd.DataFrame | None = None) -> pd.DataFrame:
    """Every choke closure (0%) that is later reopened = one build-up."""
    if choke is None:
        choke = pd.read_csv(DATA / "choke_events.csv", parse_dates=["timestamp"])
    ch = choke.sort_values(["well_name", "timestamp"]).copy()
    ch["reopen"] = ch.groupby("well_name").timestamp.shift(-1)
    s = ch[(ch.choke_opening_pct == 0) & ch.reopen.notna()][["well_name", "timestamp", "reopen"]]
    return s.rename(columns={"timestamp": "t_shut"}).reset_index(drop=True)


def bourdet(dt: np.ndarray, p: np.ndarray, x_eq: np.ndarray):
    """Derivative dP/dln(equivalent time) on a log grid, 10 points per cycle."""
    grid = np.arange(np.log(1 / 60), x_eq.max() + 1e-9, LN10 / 10)
    der = np.full(grid.shape, np.nan)
    for i, g in enumerate(grid):
        sel = np.abs(x_eq - g) <= LN10 * DERIV_L
        if sel.sum() >= 3:
            der[i] = np.polyfit(x_eq[sel], p[sel], 1)[0]
    return np.exp(grid), der


def pick_window(t_grid: np.ndarray, der: np.ndarray, t_max: float):
    """Flattest half-cycle of the derivative after wellbore storage: the radial-flow window."""
    n = int(round(WINDOW_CYCLES * 10))
    best, best_score = None, np.inf
    for i in range(len(t_grid) - n):
        a, b = t_grid[i], t_grid[i + n]
        seg = der[i:i + n + 1]
        if a < MIN_START_H or b > t_max or np.isnan(seg).any() or (seg <= 0).any():
            continue
        score = abs(np.polyfit(np.log10(t_grid[i:i + n + 1]), np.log10(seg), 1)[0])
        if score < best_score:
            best, best_score = (a, b), score
    return best, best_score


def extend_window(t_grid: np.ndarray, der: np.ndarray, t_max: float, w0: float, w1: float):
    """Grow the flattest half-cycle to the whole radial-flow plateau: neighbouring derivative points
    within PLATEAU_TOL of its level. More points on the Horner line = a steadier slope."""
    inside = np.where((t_grid >= w0) & (t_grid <= w1))[0]
    level = np.nanmedian(der[inside])
    near = (np.abs(der / level - 1) < PLATEAU_TOL) & (t_grid >= MIN_START_H) & (t_grid <= t_max)
    i0, i1 = inside[0], inside[-1]
    while i0 > 0 and near[i0 - 1]:
        i0 -= 1
    while i1 < len(near) - 1 and near[i1 + 1]:
        i1 += 1
    return t_grid[i0], t_grid[i1]


def analyse(well: str, t_shut, reopen, hf, daily, pvt) -> tuple[dict, dict]:
    P = pvt.loc[well]
    d = daily[daily.well_name == well]
    before = d[d.date < t_shut.normalize()]
    full = before[before.uptime >= 0.999]
    if full.empty:
        raise ValueError("no fully flowing day before the shut-in, so there is no rate to use")
    q = float(full.oil_stbd.iloc[-1])
    q_date = before[before.uptime >= 0.999].date.iloc[-1]
    np_cum = float(before.oil_stbd.sum() + d[d.date == t_shut.normalize()].oil_stbd.sum())
    tp = np_cum / q * 24

    g = hf[(hf.well_name == well) & (hf.timestamp >= t_shut - pd.Timedelta("1h")) & (hf.timestamp < reopen)]
    pwf = float(g[g.timestamp < t_shut].dh_pressure_psia.dropna().tail(10).mean())
    bu = g[g.timestamp >= t_shut].dropna(subset=["dh_pressure_psia"])
    dt = ((bu.timestamp - t_shut).dt.total_seconds() / 3600).to_numpy()
    p = bu.dh_pressure_psia.to_numpy()
    keep = dt > 0
    dt, p = dt[keep], p[keep]
    if len(dt) < 60 or dt.max() < 2:
        raise ValueError("fewer than 2 hours of downhole pressure after the shut-in")

    horner = (tp + dt) / dt
    x_eq = np.log(dt * tp / (tp + dt))          # Agarwal equivalent time (build-up after tp)
    t_grid, der = bourdet(dt, p, x_eq)
    window, flatness = pick_window(t_grid, der, dt.max())
    if window is None:
        raise ValueError("no flat stretch of the derivative (radial flow) was found")
    w0, w1 = window
    if EXTEND_WINDOW:
        w0, w1 = extend_window(t_grid, der, dt.max(), w0, w1)
    sel = (dt >= w0) & (dt <= w1)
    slope, icpt = np.polyfit(np.log10(horner[sel]), p[sel], 1)
    m = -slope
    k = 162.6 * q * P.oil_fvf_rb_stb * P.oil_viscosity_cp / (m * P.net_pay_thickness_ft)
    p1hr = slope * np.log10(tp + 1) + icpt
    skin = 1.151 * ((p1hr - pwf) / m - np.log10(k / (P.porosity_frac * P.oil_viscosity_cp
                                                       * P.total_compressibility_1_psi
                                                       * P.wellbore_radius_ft ** 2)) + 3.23)
    p_star = icpt  # extrapolated pressure at Horner ratio = 1
    dps = 0.87 * m * skin
    # Diagnostics for the interpretation: derivative before / after the radial-flow window
    ok = ~np.isnan(der)
    level = m / 2.303
    early = der[ok & (t_grid < w0)]
    late = der[ok & (t_grid > w1)][-4:]
    r_inv = 0.029 * np.sqrt(k * dt.max() / (P.porosity_frac * P.oil_viscosity_cp * P.total_compressibility_1_psi))
    res = {
        "well_name": well, "t_shut": t_shut, "duration_hr": round((reopen - t_shut).total_seconds() / 3600, 2),
        "q_pred_stbd": round(q, 1), "q_date": q_date.date().isoformat(), "np_pred_stb": round(np_cum),
        "tp_hr": round(tp, 1), "pwf_psia": round(pwf, 1), "window_start_hr": round(w0, 2),
        "window_end_hr": round(w1, 2), "m_psi_cycle": m, "p1hr_psia": round(p1hr, 1), "p_star_psia": round(p_star, 1),
        "k_md": k, "skin": skin, "dP_skin": dps,
        "flow_efficiency": (p_star - pwf - dps) / (p_star - pwf),
        "early_hump": float(early.max() / level) if len(early) else None,
        "late_trend": float(np.median(late) / level) if len(late) else None,
        "radius_investigated_ft": float(r_inv),
        "bubble_point_psia": float(P.bubble_point_pressure_psia),
    }
    # downsample for plots / web (log-spaced)
    idx = np.unique(np.searchsorted(dt, np.logspace(np.log10(dt.min()), np.log10(dt.max()), 160)).clip(0, len(dt) - 1))
    curves = {
        "dt": dt[idx].round(4).tolist(), "p": p[idx].round(2).tolist(), "horner": horner[idx].round(3).tolist(),
        "der_t": t_grid[~np.isnan(der)].round(4).tolist(), "der": der[~np.isnan(der)].round(3).tolist(),
        "line": [slope, icpt],
    }
    return res, curves


def plot(res: dict, c: dict, key: pd.Series | None, out_dir=OUT):
    oil, ink, grey, accent = "#A2845E", "#1C1C1E", "#8E8E93", "#007AFF"
    plt.rcParams.update({"font.family": "Helvetica", "font.size": 10, "axes.edgecolor": "#C6C6C8",
                         "axes.spines.top": False, "axes.spines.right": False})
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(12, 4.6))
    dt, p, hr = np.array(c["dt"]), np.array(c["p"]), np.array(c["horner"])
    win = (dt >= res["window_start_hr"]) & (dt <= res["window_end_hr"])

    a1.scatter(hr[~win], p[~win], s=10, color=grey, alpha=.6, label="Build-up pressure")
    a1.scatter(hr[win], p[win], s=14, color=oil, label="Radial-flow window")
    xs = np.logspace(0, np.log10(hr.max() * 1.2), 50)
    a1.plot(xs, c["line"][0] * np.log10(xs) + c["line"][1], color=accent, lw=1.5,
            label=f"Horner line, m = {res['m_psi_cycle']:.1f} psi/cycle")
    a1.set_xscale("log"); a1.invert_xaxis()
    a1.set_xlabel("Horner time ratio (tp + Δt) / Δt"); a1.set_ylabel("Downhole pressure, psia")
    a1.set_title(f"{res['well_name']} Horner plot, shut-in {res['t_shut']:%d %b %Y %H:%M}", loc="left")
    a1.legend(frameon=False, fontsize=9); a1.grid(alpha=.25)

    dp = p - res["pwf_psia"]
    a2.loglog(dt, np.clip(dp, 1e-2, None), "o", ms=3, color=ink, alpha=.7, label="Δp")
    a2.loglog(c["der_t"], np.clip(c["der"], 1e-2, None), "o", ms=3, color=oil, label="Derivative")
    a2.axvspan(res["window_start_hr"], res["window_end_hr"], color=oil, alpha=.12, label="Radial-flow window")
    a2.axhline(res["m_psi_cycle"] / 2.303, color=accent, lw=1, ls="--", label="m / 2.303")
    a2.set_xlabel("Shut-in time Δt, hours"); a2.set_ylabel("psi")
    a2.set_title("Log-log diagnostic plot", loc="left"); a2.legend(frameon=False, fontsize=9); a2.grid(alpha=.25, which="both")

    txt = (f"q (predicted) = {res['q_pred_stbd']:,.0f} STB/d    k = {res['k_md']:.1f} md    "
           f"skin = {res['skin']:.2f}    ΔP skin = {res['dP_skin']:.1f} psi")
    if key is not None:
        txt += (f"\nAnswer key: m = {key.m_psi_cycle:.1f}    k = {key.k_md:.1f} md    "
                f"skin = {key.skin:.2f}    ΔP skin = {key.dP_skin:.1f} psi")
    fig.text(0.01, -0.02, txt, fontsize=10, va="top")
    fig.tight_layout()
    path = out_dir / f"{res['well_name']}_{res['t_shut']:%Y%m%d}.png"
    fig.savefig(path, dpi=140, bbox_inches="tight")
    plt.close(fig)
    return path


def write_submission(out: pd.DataFrame, path=RESULT):
    """Phase 2 result file in the column order of data/pta_submission_template (1).csv."""
    template = next(DATA.glob("pta_submission_template*.csv"))
    columns = pd.read_csv(template, nrows=0).columns.tolist()
    sub = pd.DataFrame({
        "well_name": out.well_name,
        "shut_in_time": pd.to_datetime(out.t_shut).dt.strftime("%Y-%m-%d %H:%M:%S"),
        "permeability_md": out.k_md,                # full precision: rounding cost score
        "skin": out.skin,
        "delta_p_skin_psi": out.dP_skin,
        "horner_slope": out.m_psi_cycle,            # psi per log cycle, positive
    })[columns].sort_values(["well_name", "shut_in_time"])
    assert sub.notna().all().all() and not sub.duplicated(["well_name", "shut_in_time"]).any()
    path.parent.mkdir(parents=True, exist_ok=True)
    sub.to_csv(path, index=False, float_format="%.15g")
    return path


def interpret(r: dict) -> dict:
    """Plain-English reading of one build-up, from the numbers and the derivative shape."""
    k, s, dps, fe = r["k_md"], r["skin"], r["dP_skin"], r["flow_efficiency"]
    pts = []
    grade = ("low" if k < 10 else "moderate" if k < 50 else "good" if k < 250 else "very good")
    pts.append(f"Permeability {k:.0f} md is {grade}: the rock lets oil reach the well "
               + ("easily." if k >= 50 else "slowly." if k < 10 else "reasonably well."))
    if s > 3:
        pts.append(f"Skin {s:.1f}: the near-well zone is damaged. About {dps:.0f} psi of drawdown is lost there "
                   f"(flow efficiency {100 * fe:.0f}%). Removing it, e.g. by acid treatment, could raise the rate "
                   f"by roughly {100 * (1 / fe - 1):.0f}% at the same drawdown.")
    elif s > 0.5:
        pts.append(f"Skin {s:.1f}: slight damage near the well ({dps:.0f} psi lost, flow efficiency {100 * fe:.0f}%). "
                   "Not urgent, but worth watching.")
    elif s >= -1:
        pts.append(f"Skin {s:.1f}: the near-well zone is in good condition (flow efficiency {100 * fe:.0f}%).")
    else:
        pts.append(f"Skin {s:.1f}: the well is stimulated, flowing better than an undamaged well "
                   f"(flow efficiency {100 * fe:.0f}%), as after fracturing or acid.")
    late = r.get("late_trend")
    if late is None:
        pts.append("The test ended inside radial flow, so nothing can be said about boundaries.")
    elif late > 1.3:
        pts.append("The derivative rises at late time: the pressure wave has met a no-flow boundary such as a sealing "
                   "fault, or poorer rock further from the well.")
    elif late < 0.7:
        pts.append("The derivative drops at late time: pressure support from outside, such as an aquifer, a gas cap "
                   "or an injector.")
    else:
        pts.append("The derivative stays flat to the end: no boundary was felt during the test "
                   "(infinite-acting radial flow).")
    if r.get("early_hump") and r["early_hump"] > 1.5 and s > 0:
        pts.append("A hump before radial flow is the usual sign of wellbore storage together with positive skin.")
    pts.append(f"Wellbore storage is over after about {r['window_start_hr']:.1f} h; radial flow is read from "
               f"{r['window_start_hr']:.1f} to {r['window_end_hr']:.1f} h.")
    pts.append(f"The test saw about {r['radius_investigated_ft']:,.0f} ft into the reservoir. "
               f"Extrapolated reservoir pressure p* is {r['p_star_psia']:,.0f} psia.")
    cycles = np.log10(r["window_end_hr"] / r["window_start_hr"])
    if cycles < 0.7:
        pts.append(f"Radial flow lasted only {cycles:.1f} log cycles, so treat k and skin as approximate.")
    if r["pwf_psia"] < r["bubble_point_psia"]:
        pts.append(f"Flowing pressure ({r['pwf_psia']:,.0f} psia) is below the bubble point "
                   f"({r['bubble_point_psia']:,.0f} psia): free gas near the well makes the single-phase result approximate.")
    if s > 3:
        headline = "Damaged well, stimulation candidate"
    elif s > 0.5:
        headline = "Slight near-well damage"
    elif s >= -1:
        headline = "Healthy near-well zone"
    else:
        headline = "Stimulated well"
    return {"headline": headline, "points": pts}


def run(hf, daily, pvt, choke=None, plot_dir=OUT, key: pd.DataFrame | None = None):
    """Analyse every build-up. Returns (table, web records with curves, list of skipped shut-ins)."""
    plot_dir.mkdir(parents=True, exist_ok=True)
    rows, web, skipped = [], [], []
    for s in shut_ins(choke).itertuples():
        try:
            if s.well_name not in pvt.index:
                raise ValueError("no reservoir properties (PVT) for this well")
            res, curves = analyse(s.well_name, s.t_shut, s.reopen, hf, daily, pvt)
        except (ValueError, IndexError) as e:
            skipped.append({"well_name": s.well_name, "t_shut": str(s.t_shut), "reason": str(e)})
            continue
        krow = None
        if key is not None:
            k = key[(key.well_name == s.well_name) & (key.t_shut == s.t_shut)]
            krow = k.iloc[0] if len(k) else None
        res["plot"] = plot(res, curves, krow, plot_dir).name
        if key is not None:
            for col in ["m_psi_cycle", "k_md", "skin", "dP_skin"]:
                res[f"key_{col}"] = None if krow is None else round(float(krow[col]), 3)
            res["k_error_pct"] = None if krow is None else round(100 * (res["k_md"] - krow.k_md) / krow.k_md, 1)
        it = interpret(res)
        res["interpretation"] = it["headline"]
        rows.append(res)
        web.append({**{k_: (v.strftime("%Y-%m-%d %H:%M") if isinstance(v, pd.Timestamp) else
                            (round(v, 3) if isinstance(v, float) else v)) for k_, v in res.items()},
                    "notes": it["points"], "curves": curves})
    out = pd.DataFrame(rows)
    if len(out):
        for col in ["flow_efficiency", "late_trend", "early_hump"]:  # k, skin, dPs, m keep full precision
            out[col] = out[col].astype(float).round(3)
    return out, web, skipped


def main() -> None:
    hf = load_high_freq()
    daily = pd.read_csv(ROOT / "outputs" / "daily_rates.csv", parse_dates=["date"])
    pvt = pd.read_csv(DATA / "reservoir_pvt.csv").set_index("well_name")
    # Answer key: used only for comparison, never as an input.
    key = pd.read_csv(DATA / "pta_results.csv", parse_dates=["t_shut"])

    out, web, skipped = run(hf, daily, pvt, key=key)
    out.to_csv(ROOT / "outputs" / "pta_predicted.csv", index=False)
    out.drop(columns=["plot"]).to_csv(RESULT.parent / "pta_results_detailed.csv", index=False)
    (ROOT / "outputs" / "pta_web.json").write_text(json.dumps(web))
    show = out[["well_name", "t_shut", "duration_hr", "q_pred_stbd", "window_start_hr", "window_end_hr",
                "m_psi_cycle", "key_m_psi_cycle", "k_md", "key_k_md", "skin", "key_skin", "dP_skin", "key_dP_skin"]]
    print(show.round(2).to_string(index=False))
    for s in skipped:
        print(f"Skipped {s['well_name']} {s['t_shut']}: {s['reason']}")
    print(f"\nWrote outputs/pta_predicted.csv and {len(out)} plots to {OUT}")
    print(f"Wrote {write_submission(out)} (Phase 2 result file)")
    print(f"Wrote {export_web()} for the web frontend")


if __name__ == "__main__":
    main()
