"""Reports for engineers: an Excel workbook and a PDF for VFM, a PDF for the build-up analysis.

Run from repo root:  python3 src/reports.py   (writes results/vfm_report.xlsx, vfm_report.pdf, pta_report.pdf)
"""
import textwrap
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd
from matplotlib.backends.backend_pdf import PdfPages

ROOT = Path(__file__).resolve().parent.parent
COL = {"oil": "#A2845E", "water": "#30B0C7", "gas": "#FF9500", "ink": "#1C1C1E", "grey": "#8E8E93"}
A4 = (8.27, 11.69)


def _style():
    plt.rcParams.update({"font.family": "Helvetica", "font.size": 9, "axes.edgecolor": "#C6C6C8",
                         "axes.spines.top": False, "axes.spines.right": False, "axes.grid": True,
                         "grid.alpha": .25})


def per_well_summary(daily: pd.DataFrame) -> pd.DataFrame:
    g = daily.groupby("well_name")
    s = pd.DataFrame({
        "days": g.size(),
        "avg_oil_stbd": g.oil_stbd.mean(), "avg_water_stbd": g.water_stbd.mean(),
        "avg_formation_gas_mscfd": g.formation_gas_mscfd.mean(), "avg_gas_lift_mscfd": g.gas_lift_mscfd.mean(),
        "cum_oil_stb": g.oil_stbd.sum(), "cum_water_stb": g.water_stbd.sum(),
        "cum_formation_gas_mscf": g.formation_gas_mscfd.sum(),
        "uptime_pct": 100 * g.uptime.mean(),
    })
    s["water_cut_pct"] = 100 * s.cum_water_stb / (s.cum_oil_stb + s.cum_water_stb)
    s["gor_scf_stb"] = 1000 * s.cum_formation_gas_mscf / s.cum_oil_stb
    return s.round(1).reset_index()


def vfm_excel(daily: pd.DataFrame, sub: pd.DataFrame, card: dict, path: Path, source: str) -> Path:
    wells = per_well_summary(daily)
    tot = wells[["cum_oil_stb", "cum_water_stb", "cum_formation_gas_mscf"]].sum()
    summary = pd.DataFrame([
        ("Data", source),
        ("Period", f"{daily.date.min():%Y-%m-%d} to {daily.date.max():%Y-%m-%d}"),
        ("Wells", daily.well_name.nunique()),
        ("Field oil, STB", round(tot.cum_oil_stb)),
        ("Field water, STB", round(tot.cum_water_stb)),
        ("Field formation gas, Mscf", round(tot.cum_formation_gas_mscf)),
        ("Field water cut, %", round(100 * tot.cum_water_stb / (tot.cum_oil_stb + tot.cum_water_stb), 1)),
        ("Model", card["name"]),
        ("Model inputs", ", ".join(card["inputs"])),
        ("Model trained on", f"{card['trained_on_tests']} well tests, {card['trained_period'][0]} to {card['trained_period'][1]}"),
        ("Error on unseen Jul-Sep well tests, %", round(card["best"]["mape"], 1)),
        ("Gas", "Formation gas, without injected lift gas"),
    ], columns=["Item", "Value"])
    path.parent.mkdir(parents=True, exist_ok=True)
    with pd.ExcelWriter(path, engine="openpyxl") as xw:
        summary.to_excel(xw, sheet_name="Summary", index=False)
        wells.to_excel(xw, sheet_name="Per well", index=False)
        daily.assign(date=daily.date.dt.date).to_excel(xw, sheet_name="Daily rates", index=False)
        sub.to_excel(xw, sheet_name="Result file", index=False)
        pd.DataFrame(card["selection"]).to_excel(xw, sheet_name="Model check", index=False)
        for ws in xw.book.worksheets:
            for col in ws.columns:
                ws.column_dimensions[col[0].column_letter].width = max(12, min(48, max(len(str(c.value or "")) for c in col[:50]) + 2))
    return path


def vfm_pdf(daily: pd.DataFrame, tests: pd.DataFrame | None, card: dict, path: Path, source: str) -> Path:
    _style()
    wells = sorted(daily.well_name.unique())
    with PdfPages(path) as pdf:
        fig = plt.figure(figsize=A4)
        fig.text(.08, .95, "Virtual flow metering report", fontsize=18, weight="bold")
        fig.text(.08, .925, f"{source}   {daily.date.min():%d %b %Y} to {daily.date.max():%d %b %Y}", color=COL["grey"])
        s = per_well_summary(daily)
        tot = s[["cum_oil_stb", "cum_water_stb", "cum_formation_gas_mscf"]].sum()
        lines = [f"Field oil {tot.cum_oil_stb / 1e6:.2f} million STB, water {tot.cum_water_stb / 1e6:.2f} million STB, "
                 f"formation gas {tot.cum_formation_gas_mscf / 1e3:,.0f} MMscf.",
                 f"Model: {card['name']}, trained on {card['trained_on_tests']} well tests. "
                 f"Average error on unseen July-September well tests {card['best']['mape']:.1f}%."]
        for i, t in enumerate(lines):
            fig.text(.08, .89 - i * .022, t)
        ax = fig.add_axes([.1, .52, .84, .3])
        piv = daily.pivot_table(index="date", columns="well_name", values="oil_stbd", aggfunc="sum").fillna(0)
        ax.stackplot(piv.index, piv.T.values, labels=piv.columns, alpha=.9)
        ax.set_title("Field oil rate by well, STB/d", loc="left"); ax.legend(ncol=5, fontsize=7, frameon=False, loc="upper left")
        ax2 = fig.add_axes([.1, .08, .84, .36]); ax2.axis("off")
        cols = ["well_name", "avg_oil_stbd", "avg_water_stbd", "avg_formation_gas_mscfd", "water_cut_pct", "uptime_pct"]
        tbl = ax2.table(cellText=s[cols].values, colLabels=["Well", "Oil STB/d", "Water STB/d", "Gas Mscf/d",
                                                            "Water cut %", "Uptime %"], loc="upper center")
        tbl.auto_set_font_size(False); tbl.set_fontsize(8); tbl.scale(1, 1.4)
        pdf.savefig(fig); plt.close(fig)

        for w in wells:
            g = daily[daily.well_name == w]
            t = tests[tests.well_name == w] if tests is not None else None
            fig, axes = plt.subplots(3, 1, figsize=A4, sharex=True)
            fig.suptitle(f"{w}: estimated daily rates", x=.08, ha="left", fontsize=14, weight="bold")
            for ax, (col, tcol, label, c) in zip(axes, [
                    ("oil_stbd", "oil_rate_stbd", "Oil, STB/d", COL["oil"]),
                    ("water_stbd", "water_rate_stbd", "Water, STB/d", COL["water"]),
                    ("formation_gas_mscfd", "gas_rate_mscfd", "Formation gas, Mscf/d", COL["gas"])]):
                ax.plot(g.date, g[col], color=c, lw=1.4, label="Estimated")
                if t is not None and len(t):
                    ax.scatter(t.test_start, t[tcol], s=22, facecolor="white", edgecolor=COL["ink"], zorder=3, label="Well test")
                ax.set_title(label, loc="left"); ax.set_ylim(bottom=0)
                ax.legend(frameon=False, fontsize=8, loc="lower left")
            fig.tight_layout(rect=(0, 0, 1, .96))
            pdf.savefig(fig); plt.close(fig)
    return path


def pta_pdf(pta: list, plot_dir: Path, path: Path, source: str) -> Path:
    """pta: the web records from pta.run() (numbers + 'notes')."""
    _style()
    with PdfPages(path) as pdf:
        fig = plt.figure(figsize=A4)
        fig.text(.08, .95, "Build-up analysis report", fontsize=18, weight="bold")
        fig.text(.08, .925, f"{source}   Horner method, single-phase oil, rate from the VFM model", color=COL["grey"])
        ax = fig.add_axes([.05, .45, .9, .44]); ax.axis("off")
        if pta:
            rows = [[p["well_name"], p["t_shut"], f"{p['duration_hr']:.1f}", f"{p['q_pred_stbd']:,.0f}",
                     f"{p['m_psi_cycle']:.1f}", f"{p['k_md']:.1f}", f"{p['skin']:.2f}", f"{p['dP_skin']:.1f}",
                     f"{p['p_star_psia']:,.0f}"] for p in pta]
            tbl = ax.table(cellText=rows, colLabels=["Well", "Shut-in", "Hours", "q STB/d", "m psi/cyc", "k md",
                                                     "Skin", "ΔP skin", "p* psia"], loc="upper center",
                           colWidths=[.08, .2, .08, .1, .11, .09, .08, .1, .1])
            tbl.auto_set_font_size(False); tbl.set_fontsize(8); tbl.scale(1, 1.6)
            for i, p in enumerate(pta):
                fig.text(.08, .62 - i * .02, f"{p['well_name']} {p['t_shut'][:10]}:  {p['interpretation']}", fontsize=9)
        else:
            fig.text(.08, .85, "No build-ups could be analysed in this data.")
        fig.text(.08, .4, "\n".join(textwrap.wrap(
            "k = 162.6 q Bo μ / (m h);  s = 1.151 [(P1hr − Pwf)/m − log(k/(φ μ ct rw²)) + 3.23];  ΔP skin = 0.87 m s. "
            "q is the model's predicted oil rate on the last fully flowing day before the shut-in. The radial-flow "
            "window is where the Bourdet derivative is flat.", 100)), fontsize=8, color=COL["grey"])
        pdf.savefig(fig); plt.close(fig)

        for p in pta:
            fig = plt.figure(figsize=A4)
            fig.text(.08, .95, f"{p['well_name']}, shut-in {p['t_shut']}", fontsize=14, weight="bold")
            fig.text(.08, .925, p["interpretation"], fontsize=11, color=COL["oil"])
            img = plt.imread(plot_dir / p["plot"])
            ax = fig.add_axes([.05, .55, .9, .35]); ax.imshow(img); ax.axis("off")
            y = .5
            for note in p["notes"]:
                for j, line in enumerate(textwrap.wrap(note, 95)):
                    fig.text(.08, y, ("•  " if j == 0 else "    ") + line, fontsize=9.5)
                    y -= .02
                y -= .008
            pdf.savefig(fig); plt.close(fig)
    return path


def main() -> None:
    import json
    import sys
    sys.path.insert(0, str(Path(__file__).parent))
    from predict import load_model
    out = ROOT / "outputs"
    daily = pd.read_csv(out / "daily_rates.csv", parse_dates=["date"])
    tests = pd.read_csv(out / "well_tests_clean.csv", parse_dates=["test_start"])
    sub = pd.read_csv(ROOT / "results" / "vfm_submission.csv")
    card = load_model()
    src = "Hackathon field data"
    print("Wrote", vfm_excel(daily, sub, card, ROOT / "results" / "vfm_report.xlsx", src))
    print("Wrote", vfm_pdf(daily, tests, card, ROOT / "results" / "vfm_report.pdf", src))
    pta = json.loads((out / "pta_web.json").read_text())
    print("Wrote", pta_pdf(pta, ROOT / "pta_plots", ROOT / "results" / "pta_report.pdf", src))


if __name__ == "__main__":
    main()
