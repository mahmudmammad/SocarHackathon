"""Flow Meter web app: upload raw well data, get VFM rates, build-up analysis and reports.

Run from the repo root:   python3 app.py      then open http://127.0.0.1:8000
The page starts on the hackathon field results; uploads are processed in the background
with the trained model in models/vfm_model.pkl and kept under runs/<id>/.
"""
import json
import shutil
import sys
import threading
import traceback
import uuid
import zipfile
from io import BytesIO
from pathlib import Path

import pandas as pd
from flask import Flask, abort, jsonify, request, send_file, send_from_directory
from werkzeug.utils import secure_filename

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "src"))
import pipeline  # noqa: E402
from data import CACHE  # noqa: E402

WEB, RUNS, OUT = ROOT / "web", ROOT / "runs", ROOT / "outputs"
STEPS = ["Reading the files", "Cleaning the sensor data", "Averaging each well-day",
         "Estimating oil, water and gas", "Analysing the build-ups", "Writing reports"]
# Files a run offers for download: name -> (folder relative to the run, label)
EXPORTS = {
    "vfm_submission.csv": "Phase 1 result file", "daily_rates.csv": "Daily rates with uptime and lift gas",
    "vfm_report.xlsx": "VFM workbook", "vfm_report.pdf": "VFM report",
    "pta_submission.csv": "Phase 2 result file", "pta_results_detailed.csv": "Build-up results with diagnostics",
    "pta_report.pdf": "Build-up report", "vfm_model_recalibrated.pkl": "Recalibrated model",
}

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 ** 3
jobs: dict[str, dict] = {}
lock = threading.Lock()


# ---- Where each run keeps its files ----------------------------------------------------------
def sample_paths() -> dict:
    return {"results": ROOT / "results", "plots": ROOT / "pta_plots", "extra": OUT}


def run_paths(rid: str) -> dict:
    if rid == "sample":
        return sample_paths()
    if not rid.isalnum() or not (RUNS / rid).is_dir():
        abort(404)
    return {"results": RUNS / rid / "results", "plots": RUNS / rid / "pta_plots", "extra": RUNS / rid}


def find_file(rid: str, name: str) -> Path | None:
    p = run_paths(rid)
    for folder in (p["results"], p["extra"]):
        if (folder / name).is_file():
            return folder / name
    return None


# ---- Pages ------------------------------------------------------------------------------------
@app.get("/")
def index():
    return send_from_directory(WEB, "index.html")


@app.get("/<path:name>")
def static_files(name):
    return send_from_directory(WEB, name)


# ---- API ----------------------------------------------------------------------------------------
@app.post("/api/runs")
def create_run():
    uploads = [f for f in request.files.getlist("files") if f.filename]
    if not uploads:
        return jsonify(error="Choose at least the sensor and choke event files."), 400
    rid = uuid.uuid4().hex[:12]
    up = RUNS / rid / "upload"
    up.mkdir(parents=True)
    for f in uploads:
        name = secure_filename(f.filename)
        if Path(name).suffix.lower() not in {".csv", ".zip"}:
            continue
        f.save(up / name)
    recal = request.form.get("recalibrate") == "true"
    with lock:
        jobs[rid] = {"id": rid, "state": "running", "step": 0, "steps": STEPS, "error": None}
    threading.Thread(target=work, args=(rid, recal), daemon=True).start()
    return jsonify(id=rid), 202


def work(rid: str, recal: bool) -> None:
    def progress(step, text):
        with lock:
            jobs[rid]["step"] = step
    try:
        pipeline.run(RUNS / rid, recalibrate=recal, progress=progress)
        # The uploaded raw files are no longer needed (hundreds of MB); a failed run keeps them for debugging
        shutil.rmtree(RUNS / rid / "upload", ignore_errors=True)
        with lock:
            jobs[rid]["state"] = "done"
    except Exception as e:  # shown to the user on the upload page
        traceback.print_exc()
        with lock:
            jobs[rid].update(state="failed", error=str(e) if isinstance(e, ValueError)
                             else f"Processing stopped: {type(e).__name__}: {e}")


@app.get("/api/runs/<rid>/status")
def status(rid):
    with lock:
        job = jobs.get(rid)
    if job is None:
        if (RUNS / rid / "data.json").is_file():
            return jsonify(id=rid, state="done", step=len(STEPS), steps=STEPS, error=None)
        abort(404)
    return jsonify(job)


@app.get("/api/runs/<rid>/data")
def data(rid):
    if rid == "sample":
        js = (WEB / "data.js").read_text()
        return app.response_class(js[js.index("{"):js.rindex("}") + 1], mimetype="application/json")
    path = RUNS / rid / "data.json" if rid.isalnum() else None
    if not path or not path.is_file():
        abort(404)
    return send_file(path, mimetype="application/json")


@app.get("/api/runs/<rid>/sensors/<well>")
def sensors(rid, well):
    """Hourly averages of every sensor for one well."""
    if rid == "sample":
        path = CACHE / "sensors_hourly.parquet"
        if not path.exists():
            src = CACHE / "high_freq_clean.parquet"
            if not src.exists():
                return jsonify(error="Sensor data is not on this computer. Run python3 src/train.py first."), 404
            pipeline.hourly_sensors(pd.read_parquet(src)).to_parquet(path)
    else:
        run_paths(rid)
        path = RUNS / rid / "sensors_hourly.parquet"
    h = pd.read_parquet(path, filters=[("well_name", "==", well)])
    if h.empty:
        abort(404)
    out = {"t": h.hour.dt.strftime("%Y-%m-%dT%H:%M").tolist()}
    for c in pipeline.SENSOR_COLS:
        if c in h:
            out[c] = [None if pd.isna(v) else v for v in h[c].round(1)]
    return jsonify(out)


@app.get("/api/runs/<rid>/exports")
def exports(rid):
    p = run_paths(rid)
    files = [{"name": n, "label": lbl, "size": f.stat().st_size}
             for n, lbl in EXPORTS.items() if (f := find_file(rid, n))]
    plots = sorted(x.name for x in p["plots"].glob("*.png")) if p["plots"].is_dir() else []
    return jsonify(files=files, plots=plots)


@app.get("/api/runs/<rid>/files/<name>")
def download(rid, name):
    if name not in EXPORTS:
        abort(404)
    f = find_file(rid, name)
    if f is None:
        abort(404)
    return send_file(f, as_attachment=request.args.get("inline") != "1", download_name=name)


@app.get("/api/runs/<rid>/plots/<name>")
def plot(rid, name):
    return send_from_directory(run_paths(rid)["plots"], name, as_attachment=request.args.get("dl") == "1")


@app.get("/api/runs/<rid>/bundle.zip")
def bundle(rid):
    """Everything in one zip: result files, reports and the build-up plots."""
    p = run_paths(rid)
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for n in EXPORTS:
            if (f := find_file(rid, n)):
                z.write(f, n)
        if p["plots"].is_dir():
            for png in sorted(p["plots"].glob("*.png")):
                z.write(png, f"pta_plots/{png.name}")
    buf.seek(0)
    return send_file(buf, mimetype="application/zip", as_attachment=True,
                     download_name=f"flow_meter_results_{rid}.zip")


@app.errorhandler(413)
def too_big(_):
    return jsonify(error="The upload is larger than 2 GB."), 413


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    a = ap.parse_args()
    print(f"Flow Meter running at http://{a.host}:{a.port}")
    app.run(host=a.host, port=a.port, threaded=True)
