"""Ablation of feature sets + final daily oil/water/gas predictions.

Run from repo root:  python3 src/train.py
"""
import numpy as np
import pandas as pd
from sklearn.compose import TransformedTargetRegressor
from sklearn.ensemble import ExtraTreesRegressor, HistGradientBoostingRegressor
from sklearn.impute import SimpleImputer
from sklearn.linear_model import RidgeCV
from sklearn.metrics import mean_absolute_percentage_error, r2_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from data import ROOT, load_high_freq, load_static, load_well_tests
from export_web import export as export_web
from submission import build as build_submission
from features import CALIBRATED, CALIBRATED_SET, FEATURE_SETS, daily_features, window_features
from predict import calibrated_input, predict_daily, save_model
from vfm_model import PhysicsIPR

OUT = ROOT / "outputs"
TARGETS = {"oil": "oil_rate_stbd", "water": "water_rate_stbd", "gas": "gas_rate_mscfd"}
SPLIT_DATE = pd.Timestamp("2025-07-01")


def models():
    log = dict(func=np.log1p, inverse_func=np.expm1)
    return {
        "ridge": TransformedTargetRegressor(make_pipeline(
            SimpleImputer(), StandardScaler(), RidgeCV(alphas=np.logspace(-3, 3, 25))), **log),
        "extra_trees": TransformedTargetRegressor(make_pipeline(
            SimpleImputer(), ExtraTreesRegressor(500, min_samples_leaf=2, random_state=0)), **log),
        "hist_gb": TransformedTargetRegressor(HistGradientBoostingRegressor(
            max_iter=300, learning_rate=0.05, min_samples_leaf=5, random_state=0), **log),
    }


def rolling(tests: pd.DataFrame, months):
    """Train on all tests before month M, test on the tests in month M."""
    folds = []
    for m in months:
        start, end = pd.Timestamp(f"2025-{m:02d}-01"), pd.Timestamp(f"2025-{m + 1:02d}-01")
        folds.append((tests.index[tests.test_start < start],
                      tests.index[(tests.test_start >= start) & (tests.test_start < end)]))
    return folds


def splits(tests: pd.DataFrame):
    """Leave-one-well-out (new well), one Jan-Jun/Jul-Sep split, and rolling monthly splits.

    choose_model_apr_jun is used only to choose the model; final_check_jul_sep is
    scored once with the chosen model, so the reported number isn't picked on its own test set.
    """
    lowo = [(tests.index[tests.well_name != w], tests.index[tests.well_name == w])
            for w in sorted(tests.well_name.unique())]
    time = [(tests.index[tests.test_start < SPLIT_DATE], tests.index[tests.test_start >= SPLIT_DATE])]
    return {"leave_one_well_out": lowo, "check_jul_sep": time,
            "choose_model_apr_jun": rolling(tests, [4, 5, 6]),
            "final_check_jul_sep": rolling(tests, [7, 8, 9])}


def model_card(tests: pd.DataFrame, per_set: pd.DataFrame, preds: pd.DataFrame, best) -> dict:
    """What gets saved next to the model: its inputs, the wells it knows, and how it was checked."""
    import sklearn
    final = preds[(preds.cv == "final_check_jul_sep") & (preds.feature_set == best.feature_set)
                  & (preds.model == best.chosen_model)]
    lowo = preds[preds.cv == "leave_one_well_out"].copy()
    lowo["e"] = 100 * (lowo.predicted - lowo.measured).abs() / lowo.measured
    return {
        "name": "Well-calibrated inflow model (PhysicsIPR)",
        "inputs": ["well_name", *CALIBRATED],
        "wells": sorted(tests.well_name.unique()),
        "trained_on_tests": len(tests),
        "trained_period": [str(tests.test_start.min().date()), str(tests.test_end.max().date())],
        "created": pd.Timestamp.now().strftime("%Y-%m-%d %H:%M"),
        "sklearn_version": sklearn.__version__,
        "selection": per_set.to_dict("records"),
        "best": {"feature_set": best.feature_set, "model": best.chosen_model,
                 "mape": float(best.final_check_mean_mape)},
        "final_check": final.assign(test_start=final.test_start.astype(str)).to_dict("records"),
        "leave_one_well_out_best_mape": float(lowo.groupby(["feature_set", "model"]).e.mean().min()),
    }


def run_folds(X, tests, folds, set_name, model_name, model):
    """Predicted oil/water/gas for every test that lands in a test fold."""
    pred = pd.DataFrame(np.nan, index=tests.index, columns=list(TARGETS.values()))
    for tr, te in folds:
        if set_name == CALIBRATED_SET:
            fit = PhysicsIPR(sorted(tests.well_name.unique())).fit(calibrated_input(X.loc[tr]), tests.loc[tr])
            pred.loc[te] = fit.predict(calibrated_input(X.loc[te])).to_numpy()
        else:
            cols = FEATURE_SETS[set_name]
            for tcol in TARGETS.values():
                pred.loc[te, tcol] = model.fit(X.loc[tr, cols], tests.loc[tr, tcol]).predict(X.loc[te, cols])
    return pred


def candidates():
    """(feature set, model name, model) for every combination in the ablation."""
    for set_name in FEATURE_SETS:
        for model_name, model in models().items():
            yield set_name, model_name, model
    yield CALIBRATED_SET, "physics_ipr", None


def evaluate(X: pd.DataFrame, tests: pd.DataFrame):
    """Return (metrics per cv/set/model/phase, per-well-test predictions from each check)."""
    rows, preds = [], []
    for cv_name, folds in splits(tests).items():
        for set_name, model_name, model in candidates():
            P = run_folds(X, tests, folds, set_name, model_name, model)
            for phase, tcol in TARGETS.items():
                y, pred = tests[tcol], P[tcol]
                m = pred.notna()
                rows.append({"cv": cv_name, "feature_set": set_name, "model": model_name,
                             "phase": phase,
                             "mape_pct": 100 * mean_absolute_percentage_error(y[m], pred[m]),
                             "r2": r2_score(y[m], pred[m])})
                preds.append(pd.DataFrame({
                    "cv": cv_name, "feature_set": set_name, "model": model_name, "phase": phase,
                    "well_name": tests.loc[m, "well_name"], "test_start": tests.loc[m, "test_start"],
                    "measured": y[m], "predicted": pred[m].round(1)}))
    return pd.DataFrame(rows), pd.concat(preds, ignore_index=True)


def main() -> None:
    OUT.mkdir(exist_ok=True)
    print("Loading data ...")
    hf, tests, static = load_high_freq(), load_well_tests(), load_static()
    X = window_features(hf, tests, static)

    print("Running ablation ...")
    res, preds = evaluate(X, tests)
    res.round(3).to_csv(OUT / "ablation_results.csv", index=False)
    preds.to_csv(OUT / "check_predictions.csv", index=False)
    tests.to_csv(OUT / "well_tests_clean.csv", index=False)
    table = res.pivot_table(index=["cv", "feature_set", "model"], columns="phase",
                            values="mape_pct").round(1)
    table["mean"] = table.mean(axis=1).round(1)
    print("\nMAPE % (lower is better)\n", table.to_string())

    # Choose set+model on Apr-Jun rolling folds only, then report its untouched Jul-Sep score
    sel, hold = table.loc["choose_model_apr_jun"], table.loc["final_check_jul_sep"]
    per_set = []
    for set_name in [*FEATURE_SETS, CALIBRATED_SET]:
        model_name = sel.loc[set_name, "mean"].idxmin()
        per_set.append({"feature_set": set_name, "chosen_model": model_name,
                        "choose_model_apr_jun_mape": sel.loc[(set_name, model_name), "mean"],
                        **{f"final_check_{p}_mape": hold.loc[(set_name, model_name), p] for p in TARGETS},
                        "final_check_mean_mape": hold.loc[(set_name, model_name), "mean"]})
    per_set = pd.DataFrame(per_set)
    per_set.to_csv(OUT / "model_selection.csv", index=False)
    print("\nModel chosen on Apr-Jun, scored on Jul-Sep (rolling monthly)\n", per_set.to_string(index=False))
    best = per_set.loc[per_set.choose_model_apr_jun_mape.idxmin()]
    best_set, best_model = best.feature_set, best.chosen_model
    print(f"\nFinal model: {best_set} + {best_model} "
          f"(chosen on Apr-Jun {best.choose_model_apr_jun_mape}%, final check Jul-Sep {best.final_check_mean_mape}%)")

    # Final model: fit on all well tests, save it as models/vfm_model.pkl, predict every well-day
    assert best_set == CALIBRATED_SET, "the saved model and the web app expect the well-calibrated model"
    fit = PhysicsIPR(sorted(tests.well_name.unique())).fit(calibrated_input(X), tests)
    path = save_model(fit, model_card(tests, per_set, preds, best))
    print(f"Wrote {path}")
    out = predict_daily(fit, daily_features(hf, static))
    out.to_csv(OUT / "daily_rates.csv", index=False)
    print(f"Wrote {OUT / 'daily_rates.csv'} ({len(out)} well-days) and ablation_results.csv")
    print(f"Wrote {export_web()} for the web frontend")
    print(f"Wrote {build_submission()} (Phase 1 result file)")


if __name__ == "__main__":
    main()
