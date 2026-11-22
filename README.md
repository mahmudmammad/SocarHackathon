# Flow Meter: virtual flow metering and build-up analysis

SOCAR hackathon. Ten gas-lifted oil wells, 1-minute sensor data from January to September 2025.

* **Phase 1, VFM:** daily oil, water and gas for every well, estimated from sensors only.
* **Phase 2, PTA:** Horner build-up analysis of every shut-in, using the Phase 1 oil rate.
* **Web app:** engineers upload raw well data and get rates, well-test plots, reservoir properties,
  an interpretation and downloadable reports.

## Deliverables

| | |
|---|---|
| Phase 1 result file | [`results/vfm_submission.csv`](results/vfm_submission.csv) |
| Phase 2 result file | [`results/pta_submission.csv`](results/pta_submission.csv) |
| Trained model | [`models/vfm_model.pkl`](models/vfm_model.pkl) |
| Notebook, run with outputs | [`notebook.ipynb`](notebook.ipynb) |
| PTA plots | [`pta_plots/`](pta_plots) |
| Reports | `results/vfm_report.xlsx`, `results/vfm_report.pdf`, `results/pta_report.pdf` |
| Web app | `app.py` + `web/` |

## Results

**Phase 1.** On July to September well tests the model had not seen (each month trained only on earlier
tests), the average error is **4.3% MAPE**: oil 3.8%, water 3.1%, gas 6.1%. By WAPE it is oil 3.4%,
water 3.6%, gas 4.8%. The model was chosen on April to June only, so the July to September score was not
used to pick it.

**Phase 2.** All 6 shut-ins inside the data (January to September) were analysed.

## How it works

**Cleaning** (`src/data.py`). The raw files in `data/` are never changed. Duplicate minutes are dropped,
the `-999.25` null code and impossible values are blanked, and each minute gets its choke opening. In the
well tests, sign-flipped rates are made positive and the GL-06 gas reported in m³ is converted to Mscf.

**Phase 1 model** (`src/vfm_model.py`, `src/train.py`). Every well gets its own numbers, learned from its
own well tests:

* liquid rate = the well's own inflow line in downhole pressure, plus a slow time trend, plus shared
  gas-lift and tubing-gradient terms;
* water cut = the well's own level and trend;
* oil = liquid × (1 − water cut), water = liquid × water cut, gas = oil × the well's average gas-oil ratio.

The model is a ridge regression. It was compared with ridge, Extra Trees and gradient boosting on three
plainer input sets (`outputs/model_selection.csv`). Rates are prorated by the share of each day the well
was flowing. Well-test results are used only as training labels, never as inputs, and `pta_results.csv`
is not used in Phase 1.

**Overfitting checks.**

| Check | Error |
|---|---|
| Tests the model learned from | 3.2% |
| Unseen next month | 4.3% |
| Repeat the last well test | 7.7% |
| Repeat the well average | 11.7% |
| Sensors shuffled within each well | 6.3% |

The model learns each well from that well's own tests. On a brand-new well, with all of that well hidden
from training, the error is about 36%. For a new well, upload its well tests in the app and turn on
recalibration.

**Phase 2** (`src/pta.py`). This is a single-phase oil Horner analysis.

* **Rate (q):** the predicted oil rate on the last fully flowing day before the shut-in.
* **Producing time (tp):** cumulative predicted oil divided by q.
* **Radial-flow window:** the flattest half log cycle of the Bourdet derivative, after 30 minutes of
  wellbore storage.
* **Formulas:**
  * k = 162.6 q Bo μ / (m h)
  * s = 1.151 [(P1hr − Pwf)/m − log(k/(φ μ ct rw²)) + 3.23]
  * ΔP skin = 0.87 m s

Each build-up also gets a plain-English reading:

* rock quality from k;
* damage or stimulation from skin, with flow efficiency and the possible gain;
* boundaries or pressure support from the late-time derivative;
* radius of investigation;
* a bubble-point warning.

## Run it

The project uses [uv](https://docs.astral.sh/uv/) for Python and packages. uv installs the right Python
(3.11 or newer) and the exact package versions in `uv.lock`, so you do not need to install Python first.

### 1. Install uv (once per computer)

```bash
# macOS or Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# Windows (PowerShell)
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"

# or, with Homebrew on macOS
brew install uv
```

Open a new terminal, then check it with `uv --version`.

### 2. Set up the project (once per clone)

```bash
git clone <repository-url>
cd SocarHackathon
uv sync                          # creates .venv with Python and the pinned packages from uv.lock
```

### 3. Start the web app

```bash
# First time only: build the cleaned-sensor cache that the Sensors page reads (about 30 seconds).
uv run python -c "import sys; sys.path.insert(0, 'src'); from data import load_high_freq; load_high_freq()"

uv run python app.py             # web app at http://127.0.0.1:8000
```

Without the first command the Sensors page shows "Sensor data is not on this computer". That message
suggests `src/train.py`, but the command above is faster and does not rewrite the model or result files.

### 4. Rebuild the results (optional)

These commands overwrite the committed model and result files.

```bash
uv run python src/train.py       # Phase 1: model check, models/vfm_model.pkl, results/vfm_submission.csv (≈3 min)
uv run python src/pta.py         # Phase 2: results/pta_submission.csv and pta_plots/
uv run python src/reports.py     # Excel and PDF reports
uv run jupyter nbconvert --to notebook --execute --inplace notebook.ipynb   # rerun the notebook
```

### Without uv

```bash
pip install -r requirements.txt  # Python 3.11 or newer
python3 app.py                   # use python3 wherever the commands above say uv run python
```

`requirements.txt` is generated from `uv.lock`. After a dependency change in `pyproject.toml`, run
`uv lock && uv export --format requirements-txt --no-hashes --no-dev -o requirements.txt`.

`data/high_freq_data.csv` (272 MB) is over GitHub's file limit, so it is committed as
`data/high_freq_data.zip`. The code reads the zip when the CSV is missing.

## Web app

`uv run python app.py`, then open http://127.0.0.1:8000. The page starts on the hackathon results.

* **Data:** upload raw files as CSV, or a ZIP of CSVs. Files are recognised by their columns, so any
  names work.
  * Needed: the 1-minute sensors and the choke events.
  * Optional: completion, PVT and well tests. Without completion or PVT, the bundled
    files are used.
  * The trained model in `models/vfm_model.pkl` is used as is. If well tests are uploaded, it can be
    recalibrated on them.
* **Sensors:** hourly field measurements per well, with shut-ins marked.
* **Rates:** daily oil, water and gas per well against the well tests.
* **Field:** all wells stacked, with totals and water cut.
* **Plot:** build your own charts. Pick wells, manifolds or the field and any of the rates, cumulatives,
  ratios (WC, GOR, WOR, GLR, RF estimate), daily sensor averages (BHP, WHP, choke, BHT …) and well tests.
  The x axis is the date or any of those variables. Each chart has zoom, pan, drag bars on both axes,
  box zoom, home, auto-scale, time-lapse, PNG/CSV export, copy to clipboard, duplicate, full screen and
  a settings panel (title, fonts, colours, lines, axes, margins). Charts are kept in the browser.
  Uses ECharts 5.5.1, saved in `web/echarts.min.js`, so it works offline.
* **Accuracy:** how the model was checked, plus a check against uploaded well tests.
* **Build-ups:** Horner and log-log plots, k, skin, ΔP skin, p* and the interpretation.
* **Export:**
  * both result files and daily rates as CSV;
  * an Excel workbook and PDF reports;
  * PNG plots;
  * everything in one ZIP.

## Repository

```
app.py                 web app (Flask): upload, processing, downloads
web/                   frontend (plain HTML/CSS/JS, hand-drawn SVG charts)
src/data.py            loading and cleaning
src/features.py        window and daily sensor averages
src/vfm_model.py       the well-calibrated model
src/train.py           model comparison, final model, .pkl
src/predict.py         load/save the model, daily rates
src/pta.py             build-up analysis, plots, interpretation
src/pipeline.py        everything above for uploaded data
src/reports.py         Excel and PDF reports
src/submission.py      Phase 1 result file in the template format
scripts/               data quality report, notebook builder
outputs/               intermediate files (model comparison, daily rates, predictions)
reports/               data quality report
```
