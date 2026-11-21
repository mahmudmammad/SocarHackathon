/* Flow Meter — frontend for the VFM and build-up results. No libraries; charts are hand-drawn SVG.
   Served by app.py, it can upload raw data and download reports. The hackathon results come from
   data.js (window.VFM_DATA, written by src/export_web.py), so the page also opens straight from disk. */
'use strict';

const API = location.protocol.startsWith('http');   // false when index.html is opened from disk
let D = window.VFM_DATA;
let WELLS = Object.keys(D.wells).sort();
let RUN = 'sample';
const PHASES = {
  oil: { label: 'Oil', unit: 'STB/d' },
  water: { label: 'Water', unit: 'STB/d' },
  gas: { label: 'Gas', unit: 'Mscf/d' },
};
const SET_LABELS = {
  '1_strict': 'Pressure, temperature and choke',
  '2_plus_gaslift': 'Adds gas-lift sensors',
  '3_plus_well_props': 'Adds well properties',
  '4_well_calibrated': 'Tuned to each well',
};
const SET_DETAIL = {
  '1_strict': 'Only what the brief names: wellhead and downhole pressure, downhole temperature, choke.',
  '2_plus_gaslift': 'Also annulus pressure and gas-lift injection rate.',
  '3_plus_well_props': 'Also fixed well data: depths, tubing size and fluid properties.',
  '4_well_calibrated': 'Each well gets its own inflow line (rate vs downhole pressure), water-cut level and slow trend over time. Oil and water come from liquid rate × water cut; gas from oil × the well’s own gas-oil ratio.',
};
const MODEL_LABELS = { ridge: 'Ridge regression', extra_trees: 'Extra Trees', hist_gb: 'Gradient boosting', physics_ipr: 'Ridge regression, one inflow line per well' };
const RANGES = [['1M', 30], ['3M', 91], ['6M', 182], ['All', Infinity]];
const DAY = 864e5, HOUR = 36e5;

const state = { page: 'data', well: WELLS[0], range: 'All', fieldPhase: 'oil', accPhase: 'oil', bu: 0, sRange: '1M' };
let draws = [];

// ---- Helpers ---------------------------------------------------------------------
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const fmt = (v, d = 0) => (v == null || Number.isNaN(v)) ? '–'
  : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const parseT = s => new Date(s.length > 10 ? s.replace(' ', 'T') : s + 'T00:00').getTime();
const dShort = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short' });
const dLong = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
const dMonth = new Intl.DateTimeFormat('en-US', { month: 'short' });
const sum = a => a.reduce((s, v) => s + (v || 0), 0);
const mean = a => { const f = a.filter(v => v != null); return f.length ? sum(f) / f.length : null; };
const trim = (v, d) => String(Number(v.toFixed(d)));
const short = v => v >= 1e6 ? trim(v / 1e6, 1) + 'M' : v >= 1e3 ? trim(v / 1e3, 1) + 'k' : trim(v, 0);
const wellColor = w => cssVar('--w' + (WELLS.indexOf(w) % 10 + 1));
const dTime = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const bytes = n => n >= 1e9 ? fmt(n / 1e9, 1) + ' GB' : n >= 1e6 ? fmt(n / 1e6, 1) + ' MB' : fmt(Math.max(n / 1e3, 1)) + ' KB';
const api = path => `/api/runs/${RUN}/${path}`;

function niceTop(max, n = 4) {
  const raw = (max || 1) / n, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  return { top, ticks };
}

function timeTicks(x0, x1) {
  const out = [];
  if (x1 - x0 > 75 * DAY) {
    const d = new Date(x0); d.setDate(1); d.setHours(0, 0, 0, 0);
    if (d.getTime() < x0) d.setMonth(d.getMonth() + 1);
    for (; d.getTime() < x1; d.setMonth(d.getMonth() + 1)) out.push({ t: d.getTime(), label: dMonth.format(d) });
  } else {
    const step = x1 - x0 > 40 * DAY ? 14 : 7;
    for (let t = x0; t < x1; t += step * DAY) out.push({ t, label: dShort.format(t) });
  }
  return out;
}

function nearest(arr, t) {
  let lo = 0, hi = arr.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (arr[mid] < t) lo = mid; else hi = mid; }
  return Math.abs(arr[lo] - t) <= Math.abs(arr[hi] - t) ? lo : hi;
}

function placeTip(tip, x, y, W) {
  tip.hidden = false;
  const tw = tip.offsetWidth;
  let left = x + 14;
  if (left + tw > W) left = x - tw - 14;
  tip.style.left = Math.max(0, left) + 'px';
  tip.style.top = y + 'px';
}

// ---- Charts ----------------------------------------------------------------------
/* Line chart over daily data. o: {id, label, x[], series[{name,y[],color,area,dash}], points[{x,y,name,color}],
   bands[{x,a}], note(i) -> extra tooltip html, height} */
function lineChart(el, o) {
  const W = el.clientWidth, H = o.height || 220, m = { l: 40, r: 6, t: 10, b: 24 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b, step = o.step || DAY;
  const x0 = o.x[0], x1 = o.x[o.x.length - 1] + step;
  const vals = o.series.flatMap(s => s.y).concat((o.points || []).map(p => p.y)).filter(v => v != null);
  let bottom = 0, pad = 0;
  if (o.fitY && vals.length) {               // sensors: zoom to the data instead of starting at 0
    const lo = Math.min(...vals), hi = Math.max(...vals);
    pad = (hi - lo) * .08 || Math.abs(hi) * .02 || 1;
    const r = niceTop(hi - lo + 2 * pad, 4), stepY = r.ticks[1] - r.ticks[0];
    bottom = Math.floor((lo - pad) / stepY) * stepY;
  }
  const hiV = vals.length ? Math.max(...vals) : 1;
  const span = o.fitY ? niceTop((hiV + pad - bottom) || 1) : niceTop(Math.max(hiV, 1) * 1.04);
  const top = bottom + span.top, ticks = span.ticks.map(v => v + bottom);
  const X = t => m.l + (t - x0) / (x1 - x0) * iw;
  const Xc = t => X(t + step / 2);
  const Y = v => m.t + ih - (v - bottom) / (top - bottom) * ih;
  const dFmt = step < DAY ? dTime : dLong;
  const tStep = ticks[1] - ticks[0], tDec = (String(+tStep.toPrecision(6)).split('.')[1] || '').length;
  const tickLabel = v => o.fitY ? fmt(v, tDec) : short(v);

  let s = `<svg width="${W}" height="${H}" role="img" aria-label="${esc(o.label)}"><defs>`;
  o.series.forEach((se, i) => {
    if (se.area) s += `<linearGradient id="${o.id}-g${i}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${se.color}" stop-opacity=".24"/><stop offset="1" stop-color="${se.color}" stop-opacity="0"/></linearGradient>`;
  });
  s += '</defs>';
  ticks.forEach(v => {
    s += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/>
      <text class="tick" x="${m.l - 8}" y="${Y(v)}" text-anchor="end" dominant-baseline="middle">${tickLabel(v)}</text>`;
  });
  (o.bands || []).forEach(b => {
    s += `<rect class="band" x="${X(b.x)}" y="${m.t}" width="${Math.max(X(b.x + (b.w || step)) - X(b.x), 1.5)}" height="${ih}" style="opacity:${b.a}"/>`;
  });
  timeTicks(x0, x1).forEach(t => { s += `<text class="tick" x="${X(t.t)}" y="${H - 6}" text-anchor="start">${t.label}</text>`; });
  o.series.forEach((se, i) => {
    // break the line where data is missing, so gaps show as gaps
    let d = '', pen = false;
    o.x.forEach((t, k) => {
      if (se.y[k] == null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${Xc(t).toFixed(1)},${Y(se.y[k]).toFixed(1)}`; pen = true;
    });
    if (!d) return;
    if (se.area) s += `<path d="${d}L${Xc(o.x[o.x.length - 1])},${Y(bottom)}L${Xc(o.x[0])},${Y(bottom)}Z" fill="url(#${o.id}-g${i})"/>`;
    s += `<path d="${d}" fill="none" stroke="${se.color}" stroke-width="${se.width || 2}" ${se.dash ? 'stroke-dasharray="3 4"' : ''}
      stroke-linejoin="round" stroke-linecap="round"/>`;
  });
  (o.points || []).forEach(p => { s += `<circle class="pt" cx="${X(p.x)}" cy="${Y(p.y)}" r="4.5" style="stroke:${p.color}"/>`; });
  s += `<line class="cursor" y1="${m.t}" y2="${m.t + ih}" visibility="hidden"/>`;
  s += o.series.map(se => `<circle class="cdot" r="4.5" fill="${se.color}" visibility="hidden"/>`).join('');
  s += `<rect class="hit" x="${m.l}" y="0" width="${iw}" height="${H}" fill="transparent"/></svg><div class="tip" hidden></div>`;
  el.innerHTML = s;

  const svg = el.querySelector('svg'), tip = el.querySelector('.tip'), cur = svg.querySelector('.cursor');
  const dots = [...svg.querySelectorAll('.cdot')], hit = svg.querySelector('.hit');
  const hide = () => { tip.hidden = true; cur.setAttribute('visibility', 'hidden'); dots.forEach(d => d.setAttribute('visibility', 'hidden')); };
  hit.addEventListener('pointermove', ev => {
    const px = ev.clientX - svg.getBoundingClientRect().left;
    const i = nearest(o.x, x0 + (px - m.l) / iw * (x1 - x0) - step / 2);
    const cx = Xc(o.x[i]);
    cur.setAttribute('x1', cx); cur.setAttribute('x2', cx); cur.setAttribute('visibility', 'visible');
    dots.forEach((dt, k) => {
      const v = o.series[k].y[i];
      dt.setAttribute('visibility', v == null ? 'hidden' : 'visible');
      if (v != null) { dt.setAttribute('cx', cx); dt.setAttribute('cy', Y(v)); }
    });
    const tests = (o.points || []).filter(p => p.x >= o.x[i] && p.x < o.x[i] + step);
    tip.innerHTML = `<div class="tip-date">${dFmt.format(o.x[i])}</div>`
      + o.series.map(se => `<div class="tip-row"><span class="sw" style="background:${se.color}"></span>${esc(se.name)}<b>${fmt(se.y[i], o.digits || 0)}</b></div>`).join('')
      + tests.map(p => `<div class="tip-row"><span class="sw ring" style="border-color:${p.color}"></span>${esc(p.name)}<b>${fmt(p.y)}</b></div>`).join('')
      + (o.note ? o.note(i) : '');
    placeTip(tip, cx, m.t, W);
  });
  hit.addEventListener('pointerleave', hide);
}

/* Stacked area by well. o: {id, label, x[], series[{name,y[],color}], unit, height} */
function stackedChart(el, o) {
  const W = el.clientWidth, H = o.height || 300, m = { l: 44, r: 6, t: 10, b: 24 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const x0 = o.x[0], x1 = o.x[o.x.length - 1] + DAY;
  const cum = []; let base = o.x.map(() => 0);
  o.series.forEach(se => { const top = base.map((b, i) => b + (se.y[i] || 0)); cum.push({ lo: base, hi: top }); base = top; });
  const { top, ticks } = niceTop(Math.max(...base, 1) * 1.04);
  const X = t => m.l + (t - x0) / (x1 - x0) * iw, Xc = t => X(t + DAY / 2), Y = v => m.t + ih - v / top * ih;

  let s = `<svg width="${W}" height="${H}" role="img" aria-label="${esc(o.label)}">`;
  ticks.forEach(v => {
    s += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/>
      <text class="tick" x="${m.l - 8}" y="${Y(v)}" text-anchor="end" dominant-baseline="middle">${short(v)}</text>`;
  });
  timeTicks(x0, x1).forEach(t => { s += `<text class="tick" x="${X(t.t)}" y="${H - 6}">${t.label}</text>`; });
  o.series.forEach((se, k) => {
    const up = o.x.map((t, i) => `${Xc(t).toFixed(1)},${Y(cum[k].hi[i]).toFixed(1)}`);
    const dn = o.x.map((t, i) => `${Xc(t).toFixed(1)},${Y(cum[k].lo[i]).toFixed(1)}`).reverse();
    s += `<path d="M${up.join('L')}L${dn.join('L')}Z" fill="${se.color}" fill-opacity=".88" stroke="var(--card)" stroke-width=".6"/>`;
  });
  s += `<line class="cursor" y1="${m.t}" y2="${m.t + ih}" visibility="hidden"/>`;
  s += `<rect class="hit" x="${m.l}" y="0" width="${iw}" height="${H}" fill="transparent"/></svg><div class="tip" hidden></div>`;
  el.innerHTML = s;

  const svg = el.querySelector('svg'), tip = el.querySelector('.tip'), cur = svg.querySelector('.cursor');
  const hit = svg.querySelector('.hit');
  hit.addEventListener('pointermove', ev => {
    const px = ev.clientX - svg.getBoundingClientRect().left;
    const i = nearest(o.x, x0 + (px - m.l) / iw * (x1 - x0) - DAY / 2), cx = Xc(o.x[i]);
    cur.setAttribute('x1', cx); cur.setAttribute('x2', cx); cur.setAttribute('visibility', 'visible');
    const rows = o.series.map(se => ({ n: se.name, c: se.color, v: se.y[i] || 0 })).sort((a, b) => b.v - a.v);
    tip.innerHTML = `<div class="tip-date">${dLong.format(o.x[i])}</div>`
      + rows.map(r => `<div class="tip-row"><span class="sw" style="background:${r.c}"></span>${r.n}<b>${fmt(r.v)}</b></div>`).join('')
      + `<div class="tip-row" style="margin-top:4px;font-weight:600">Field<b>${fmt(base[i])} ${o.unit}</b></div>`;
    placeTip(tip, cx, m.t, W);
  });
  hit.addEventListener('pointerleave', () => { tip.hidden = true; cur.setAttribute('visibility', 'hidden'); });
}

/* Estimated vs measured. o: {points[{x,y,well,t}], color, unit, height} */
function scatterChart(el, o) {
  const W = el.clientWidth, H = o.height || 320, m = { l: 48, r: 10, t: 10, b: 40 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const { top, ticks } = niceTop(Math.max(...o.points.flatMap(p => [p.x, p.y]), 1) * 1.04);
  const X = v => m.l + v / top * iw, Y = v => m.t + ih - v / top * ih;
  let s = `<svg width="${W}" height="${H}" role="img" aria-label="Estimated versus measured ${esc(o.unit)}">`;
  ticks.forEach(v => {
    s += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/>
      <text class="tick" x="${m.l - 8}" y="${Y(v)}" text-anchor="end" dominant-baseline="middle">${short(v)}</text>
      <text class="tick" x="${X(v)}" y="${m.t + ih + 16}" text-anchor="middle">${short(v)}</text>`;
  });
  s += `<text class="tick" x="${m.l + iw / 2}" y="${H - 2}" text-anchor="middle">Measured in well test, ${o.unit}</text>`;
  s += `<text class="tick" transform="translate(11 ${m.t + ih / 2}) rotate(-90)" text-anchor="middle">Estimated, ${o.unit}</text>`;
  s += `<line class="diag" x1="${X(0)}" y1="${Y(0)}" x2="${X(top)}" y2="${Y(top)}"/>`;
  o.points.forEach(p => { s += `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="5.5" fill="${o.color}" fill-opacity=".85" stroke="var(--card)" stroke-width="1.5"/>`; });
  s += `<rect class="hit" x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" fill="transparent"/></svg><div class="tip" hidden></div>`;
  el.innerHTML = s;
  const svg = el.querySelector('svg'), tip = el.querySelector('.tip'), hit = svg.querySelector('.hit');
  hit.addEventListener('pointermove', ev => {
    const r = svg.getBoundingClientRect(), px = ev.clientX - r.left, py = ev.clientY - r.top;
    let best = null, bd = 400;
    o.points.forEach(p => { const d = (X(p.x) - px) ** 2 + (Y(p.y) - py) ** 2; if (d < bd) { bd = d; best = p; } });
    if (!best) { tip.hidden = true; return; }
    const err = 100 * Math.abs(best.y - best.x) / best.x;
    tip.innerHTML = `<div class="tip-date">${best.well}, ${dShort.format(parseT(best.t))}</div>
      <div class="tip-row">Measured<b>${fmt(best.x)}</b></div><div class="tip-row">Estimated<b>${fmt(best.y)}</b></div>
      <div class="tip-note">Off by ${fmt(err, 1)}%</div>`;
    placeTip(tip, X(best.x), Math.max(0, Y(best.y) - 30), W);
  });
  hit.addEventListener('pointerleave', () => { tip.hidden = true; });
}

/* x–y chart with optional log axes, for the build-up plots.
   o: {label, xLog, yLog, xReverse, height, xLabel, yLabel, band:[x0,x1], hline:{y,name},
       layers:[{name, x[], y[], color, kind:'dot'|'line', r}], tip(layer, i) -> html} */
function xyChart(el, o) {
  const W = el.clientWidth, H = o.height || 320, m = { l: 56, r: 12, t: 12, b: 42 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const tx = v => o.xLog ? Math.log10(v) : v, ty = v => o.yLog ? Math.log10(v) : v;
  const okY = v => v != null && (!o.yLog || v > 0);
  const xs = o.layers.flatMap(l => l.x).map(tx);
  const ys = o.layers.flatMap(l => l.y.filter(okY)).concat(o.hline ? [o.hline.y] : []).map(ty);
  let xa = Math.min(...xs), xb = Math.max(...xs), ya = Math.min(...ys), yb = Math.max(...ys);
  if (o.xLog) { xa = Math.floor(xa); xb = Math.ceil(xb); }
  if (o.yLog) { ya = Math.floor(ya); yb = Math.ceil(yb); } else { const pad = (yb - ya) * .06 || 1; ya -= pad; yb += pad; }
  const X = v => { let f = (tx(v) - xa) / (xb - xa); if (o.xReverse) f = 1 - f; return m.l + f * iw; };
  const Y = v => m.t + ih - (ty(v) - ya) / (yb - ya) * ih;
  const logLabel = e => { const v = 10 ** e; return v >= 1000 ? short(v) : String(+v.toPrecision(1)); };

  let s = `<svg width="${W}" height="${H}" role="img" aria-label="${esc(o.label)}">`;
  const yTicks = [];
  if (o.yLog) for (let e = ya; e <= yb; e++) yTicks.push([10 ** e, logLabel(e)]);
  else {
    const raw = (yb - ya) / 5, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
    const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
    for (let v = Math.ceil(ya / step) * step; v <= yb; v += step) yTicks.push([v, fmt(v)]);
  }
  yTicks.forEach(([v, l]) => {
    s += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/>
      <text class="tick" x="${m.l - 8}" y="${Y(v)}" text-anchor="end" dominant-baseline="middle">${l}</text>`;
  });
  for (let e = Math.ceil(xa); e <= xb; e++) {
    const v = o.xLog ? 10 ** e : e;
    s += `<line class="grid" x1="${X(v)}" x2="${X(v)}" y1="${m.t}" y2="${m.t + ih}"/>
      <text class="tick" x="${X(v)}" y="${m.t + ih + 16}" text-anchor="middle">${o.xLog ? logLabel(e) : e}</text>`;
  }
  s += `<text class="tick" x="${m.l + iw / 2}" y="${H - 2}" text-anchor="middle">${esc(o.xLabel)}</text>`;
  s += `<text class="tick" transform="translate(12 ${m.t + ih / 2}) rotate(-90)" text-anchor="middle">${esc(o.yLabel)}</text>`;
  if (o.band) {
    const [a, b] = o.band.map(X).sort((p, q) => p - q);
    s += `<rect x="${a}" y="${m.t}" width="${b - a}" height="${ih}" fill="var(--oil)" opacity=".13"/>`;
  }
  if (o.hline) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(o.hline.y)}" y2="${Y(o.hline.y)}" stroke="var(--tint)" stroke-dasharray="5 4" stroke-width="1.2"/>`;
  s += `<clipPath id="${o.id}-clip"><rect x="${m.l}" y="${m.t}" width="${iw}" height="${ih}"/></clipPath><g clip-path="url(#${o.id}-clip)">`;
  o.layers.forEach(l => {
    if (l.kind === 'line') {
      s += `<path d="M${l.x.map((x, i) => `${X(x).toFixed(1)},${Y(l.y[i]).toFixed(1)}`).join('L')}" fill="none" stroke="${l.color}" stroke-width="2"/>`;
    } else {
      l.x.forEach((x, i) => { if (okY(l.y[i])) s += `<circle cx="${X(x).toFixed(1)}" cy="${Y(l.y[i]).toFixed(1)}" r="${l.r || 3}" fill="${l.color}"/>`; });
    }
  });
  s += `</g><rect class="hit" x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" fill="transparent"/></svg><div class="tip" hidden></div>`;
  el.innerHTML = s;

  const svg = el.querySelector('svg'), tip = el.querySelector('.tip'), hit = svg.querySelector('.hit');
  hit.addEventListener('pointermove', ev => {
    const r = svg.getBoundingClientRect(), px = ev.clientX - r.left, py = ev.clientY - r.top;
    let best = null, bd = 300;
    o.layers.forEach(l => {
      if (l.kind === 'line') return;
      l.x.forEach((x, i) => { if (!okY(l.y[i])) return; const d = (X(x) - px) ** 2 + (Y(l.y[i]) - py) ** 2; if (d < bd) { bd = d; best = [l, i]; } });
    });
    if (!best) { tip.hidden = true; return; }
    tip.innerHTML = o.tip(...best);
    placeTip(tip, X(best[0].x[best[1]]), Math.max(0, Y(best[0].y[best[1]]) - 40), W);
  });
  hit.addEventListener('pointerleave', () => { tip.hidden = true; });
}

// ---- UI pieces -------------------------------------------------------------------
const segmented = (name, options, value, label) =>
  `<div class="segmented" role="group" aria-label="${label}" data-seg="${name}">${options.map(([v, l]) =>
    `<button type="button" data-v="${v}" aria-pressed="${v === value}">${l}</button>`).join('')}</div>`;

const stat = (kind, label, value, unit, sub) => `<div class="stat">
  <div class="stat-label ${kind}"><span class="dot"></span>${label}</div>
  <div class="stat-value">${value}<span class="stat-unit">${unit}</span></div>
  ${sub ? `<div class="stat-sub">${sub}</div>` : ''}</div>`;

const chevron = '<svg class="chev" viewBox="0 0 8 13" aria-hidden="true"><path d="M1.5 1.5 6.5 6.5 1.5 11.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const infoIcon = '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 9v5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="10" cy="6.2" r="1.1" fill="currentColor"/></svg>';

function rangeStart(lastT) {
  const days = RANGES.find(r => r[0] === state.range)[1];
  return days === Infinity ? -Infinity : lastT - (days - 1) * DAY;
}

function wellSlice(w) {
  const d = D.wells[w], x = d.date.map(parseT), start = rangeStart(x[x.length - 1]);
  const idx = x.map((t, i) => t >= start ? i : -1).filter(i => i >= 0);
  const pick = k => idx.map(i => d[k][i]);
  return { x: idx.map(i => x[i]), oil: pick('oil'), water: pick('water'), gas: pick('gas'),
           lift: pick('lift'), total: pick('total'), uptime: pick('uptime') };
}

function fieldSlice() {
  const all = [...new Set(WELLS.flatMap(w => D.wells[w].date))].sort().map(parseT);
  const start = rangeStart(all[all.length - 1]);
  const x = all.filter(t => t >= start);
  const pos = new Map(x.map((t, i) => [t, i]));
  const per = {};
  WELLS.forEach(w => {
    const d = D.wells[w], s = { oil: x.map(() => 0), water: x.map(() => 0), gas: x.map(() => 0), uptime: [] };
    d.date.forEach((ds, i) => {
      const k = pos.get(parseT(ds));
      if (k === undefined) return;
      s.oil[k] = d.oil[i] || 0; s.water[k] = d.water[i] || 0; s.gas[k] = d.gas[i] || 0; s.uptime.push(d.uptime[i]);
    });
    per[w] = s;
  });
  return { x, per };
}

function finalErrors(phase) {
  const rows = D.final.filter(r => !phase || r.phase === phase);
  const by = {};
  rows.forEach(r => { (by[r.well] = by[r.well] || []).push(100 * Math.abs(r.predicted - r.measured) / r.measured); });
  return Object.fromEntries(Object.entries(by).map(([w, a]) => [w, mean(a)]));
}

// ---- Pages -----------------------------------------------------------------------
function pageWells(view) {
  const sl = wellSlice(state.well), tests = (D.tests[state.well] || [])
    .map(t => ({ ...t, x: parseT(t.t) })).filter(t => t.x >= sl.x[0] && t.x < sl.x[sl.x.length - 1] + DAY);
  const liquid = sum(sl.oil) + sum(sl.water);
  const shutDays = sl.uptime.filter(u => u < 1).length;

  view.innerHTML = `
    <header class="page-head">
      <h1 class="large-title">${state.well}</h1>
      <p class="subtitle">Daily oil, water and gas, estimated from wellhead and downhole sensors.</p>
    </header>
    <div class="controls">
      <div class="chips" role="group" aria-label="Well">${WELLS.map(w =>
        `<button type="button" class="chip" data-well="${w}" aria-pressed="${w === state.well}">${w}</button>`).join('')}</div>
      ${segmented('range', RANGES.map(r => [r[0], r[0]]), state.range, 'Time range')}
    </div>
    <section class="summary" aria-label="Averages">
      ${stat('oil', 'Oil', fmt(mean(sl.oil)), 'STB/d')}
      ${stat('water', 'Water', fmt(mean(sl.water)), 'STB/d')}
      ${stat('gas', 'Gas', fmt(mean(sl.gas)), 'Mscf/d', `Plus ${fmt(mean(sl.lift))} Mscf/d lift gas`)}
      ${stat('', 'Water cut', liquid ? fmt(100 * sum(sl.water) / liquid, 1) : '–', '%')}
      ${stat('', 'Uptime', fmt(100 * mean(sl.uptime), 1), '%', `${shutDays} ${shutDays === 1 ? 'day' : 'days'} with a shut-in`)}
    </section>
    <p class="footnote">Daily averages from ${dLong.format(sl.x[0])} to ${dLong.format(sl.x[sl.x.length - 1])}.
      ${tests.length} well ${tests.length === 1 ? 'test' : 'tests'} in this period.</p>
    ${Object.entries(PHASES).map(([p, ph]) => `
      <section class="card">
        <div class="card-head"><h2>${ph.label}</h2><span class="unit">${ph.unit}</span></div>
        <div class="chart" id="ch-${p}"></div>
        <div class="legend">
          <span><i style="background:var(--${p})"></i>${p === 'gas' ? 'From the reservoir, estimated' : 'Estimated'}</span>
          ${p === 'gas' ? '<span><i class="dash"></i>Total with lift gas, estimated</span>' : ''}
          <span><i class="ring"></i>Well test</span>
          ${shutDays ? '<span><i class="band"></i>Shut-in day</span>' : ''}
        </div>
      </section>`).join('')}
    <details class="card">
      <summary>Daily values</summary>
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Oil, STB/d</th><th>Water, STB/d</th><th>Gas, Mscf/d</th><th>Lift gas, Mscf/d</th><th>Water cut</th><th>Uptime</th></tr></thead>
        <tbody>${sl.x.map((t, i) => {
          const l = (sl.oil[i] || 0) + (sl.water[i] || 0);
          return `<tr><td>${dLong.format(t)}</td><td>${fmt(sl.oil[i])}</td><td>${fmt(sl.water[i])}</td><td>${fmt(sl.gas[i])}</td>
            <td>${fmt(sl.lift[i])}</td><td>${l ? fmt(100 * sl.water[i] / l, 1) + '%' : '–'}</td><td>${fmt(100 * sl.uptime[i], 0)}%</td></tr>`;
        }).join('')}</tbody></table></div>
      <button type="button" class="btn" id="download">Download CSV</button>
    </details>`;

  const bands = sl.uptime.map((u, i) => u < 1 ? { x: sl.x[i], a: .1 + .3 * (1 - u) } : null).filter(Boolean);
  const note = i => sl.uptime[i] < 1 ? `<div class="tip-note">Flowing ${fmt(100 * sl.uptime[i])}% of the day</div>` : '';
  draws.push(() => {
    const c = Object.fromEntries(Object.keys(PHASES).map(p => [p, cssVar('--' + p)]));
    lineChart(document.getElementById('ch-oil'), { id: 'oil', label: 'Daily oil rate', x: sl.x, bands, note,
      series: [{ name: 'Estimated', y: sl.oil, color: c.oil, area: true }],
      points: tests.map(t => ({ x: t.x, y: t.oil, name: 'Well test', color: cssVar('--label') })) });
    lineChart(document.getElementById('ch-water'), { id: 'water', label: 'Daily water rate', x: sl.x, bands, note,
      series: [{ name: 'Estimated', y: sl.water, color: c.water, area: true }],
      points: tests.map(t => ({ x: t.x, y: t.water, name: 'Well test', color: cssVar('--label') })) });
    lineChart(document.getElementById('ch-gas'), { id: 'gas', label: 'Daily gas rate', x: sl.x, bands, note,
      series: [{ name: 'From reservoir', y: sl.gas, color: c.gas, area: true },
               { name: 'Total with lift gas', y: sl.total, color: cssVar('--secondary'), width: 1.5, dash: true }],
      points: tests.map(t => ({ x: t.x, y: t.gas, name: 'Well test', color: cssVar('--label') })) });
  });

  document.getElementById('download').addEventListener('click', () => {
    const rows = [['date', 'oil_stbd', 'water_stbd', 'formation_gas_mscfd', 'gas_lift_mscfd', 'total_gas_mscfd', 'uptime']]
      .concat(sl.x.map((t, i) => [new Date(t).toISOString().slice(0, 10), sl.oil[i], sl.water[i], sl.gas[i], sl.lift[i], sl.total[i], sl.uptime[i]]));
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([rows.map(r => r.join(',')).join('\n')], { type: 'text/csv' })),
      download: `${state.well}_daily_rates.csv` });
    a.click(); URL.revokeObjectURL(a.href);
  });
}

function pageField(view) {
  const { x, per } = fieldSlice();
  const tot = p => sum(WELLS.map(w => sum(per[w][p])));
  const oil = tot('oil'), water = tot('water'), gas = tot('gas');
  const errs = finalErrors();
  const ph = PHASES[state.fieldPhase];
  const avgOil = Object.fromEntries(WELLS.map(w => [w, mean(per[w].oil)]));
  const maxOil = Math.max(...Object.values(avgOil));
  const days = x.length;

  view.innerHTML = `
    <header class="page-head">
      <h1 class="large-title">Field</h1>
      <p class="subtitle">All ${WELLS.length} wells added together.</p>
    </header>
    <div class="controls">
      ${segmented('fieldPhase', Object.entries(PHASES).map(([k, v]) => [k, v.label]), state.fieldPhase, 'Fluid')}
      ${segmented('range', RANGES.map(r => [r[0], r[0]]), state.range, 'Time range')}
    </div>
    <section class="summary" aria-label="Field totals">
      ${stat('oil', 'Oil produced', fmt(oil / 1e6, 2), 'million bbl', `${fmt(oil / days)} STB/d on average`)}
      ${stat('water', 'Water produced', fmt(water / 1e6, 2), 'million bbl', `${fmt(water / days)} STB/d on average`)}
      ${stat('gas', 'Gas produced', fmt(gas / 1e3), 'MMscf', 'From the reservoir, without lift gas')}
      ${stat('', 'Water cut', fmt(100 * water / (oil + water), 1), '%')}
    </section>
    <p class="footnote">${days} days, ${dLong.format(x[0])} to ${dLong.format(x[x.length - 1])}.</p>
    <section class="card">
      <div class="card-head"><h2>${ph.label} by well</h2><span class="unit">${ph.unit}</span></div>
      <div class="chart" id="ch-field"></div>
      <div class="legend">${WELLS.map(w => `<span><i style="background:${wellColor(w)};height:10px;width:10px;border-radius:3px"></i>${w}</span>`).join('')}</div>
    </section>
    <h2 class="section-title">Wells</h2>
    <div class="list" role="list">
      ${[...WELLS].sort((a, b) => avgOil[b] - avgOil[a]).map(w => {
        const o = sum(per[w].oil), wa = sum(per[w].water);
        return `<button type="button" class="row" role="listitem" data-goto="${w}" aria-label="Open ${w}">
          <span class="row-title">${w}</span>
          <span><span class="row-detail">${fmt(avgOil[w])} STB/d oil, water cut ${fmt(100 * wa / (o + wa), 1)}%</span>
            <span class="row-bar"><span style="width:${100 * avgOil[w] / maxOil}%;background:var(--oil)"></span></span></span>
          <span class="row-value">${fmt(errs[w], 1)}%<small>model error</small></span>
          ${chevron}</button>`;
      }).join('')}
    </div>
    <p class="footnote">Model error is the average difference from July to September well tests the model had not seen.</p>`;

  draws.push(() => stackedChart(document.getElementById('ch-field'), {
    id: 'field', label: `Field ${ph.label.toLowerCase()} rate by well`, x, unit: ph.unit, height: 320,
    series: WELLS.map(w => ({ name: w, y: per[w][state.fieldPhase], color: wellColor(w) })) }));
}

function pageAccuracy(view) {
  const sel = D.selection, best = sel.find(r => r.feature_set === D.best.feature_set);
  const p = state.accPhase, ph = PHASES[p];
  const pts = D.final.filter(r => r.phase === p).map(r => ({ x: r.measured, y: r.predicted, well: r.well, t: r.t }));
  const errs = finalErrors(p), errWells = Object.keys(errs).sort();
  const maxErr = Math.max(...Object.values(errs), 1);
  const maxSet = Math.max(...sel.flatMap(r => Object.keys(PHASES).map(k => r[`final_check_${k}_mape`])));

  const ck = (D.check || []).filter(r => r.phase === p);
  const ckErr = ph_ => mean((D.check || []).filter(r => r.phase === ph_).map(r => 100 * Math.abs(r.predicted - r.measured) / r.measured));
  const checkHtml = !ck.length ? '' : `
    <h2 class="section-title">Your uploaded well tests</h2>
    <section class="card hero">
      <div class="hero-value">${fmt(mean(Object.keys(PHASES).map(ckErr)), 1)}<small>%</small></div>
      <p>Average error of the model against the <b>${ck.length} well tests</b> in the upload.
        ${D.source && D.source.recalibrated ? 'The model was recalibrated on these tests, so this shows the fit, not an independent check.'
          : D.model && ck.every(r => r.t <= D.model.trained_period[1]) ? 'These tests fall inside the period the model was trained on, so this shows how well it fits, not an independent check.'
          : 'The saved model was used as is. Tests after its training period are an independent check.'}</p>
      <div class="hero-phases">${Object.entries(PHASES).map(([k, v]) =>
        `<div><span class="stat-label ${k}" style="display:inline-flex"><span class="dot"></span>${v.label}</span><b>${fmt(ckErr(k), 1)}%</b></div>`).join('')}</div>
    </section>
    <section class="card">
      <div class="card-head"><h2>Estimated vs measured</h2><span class="aside">${ph.label}, uploaded tests</span></div>
      <div class="chart" id="ch-check"></div>
    </section>`;

  view.innerHTML = `
    <header class="page-head">
      <h1 class="large-title">Accuracy</h1>
      <p class="subtitle">How close the estimates are to well tests the model never saw.${RUN !== 'sample'
        ? ' The top part is the saved model’s own check from training; your uploaded well tests are further down.' : ''}</p>
    </header>
    <section class="card hero">
      <div class="hero-value">${fmt(D.best.mape, 1)}<small>%</small></div>
      <p>Average error on <b>July to September</b> well tests. Each month the model learned from all earlier
        well tests, then predicted that month without seeing the answers. The inputs and model were picked
        on April to June only.</p>
      <div class="hero-phases">${Object.entries(PHASES).map(([k, v]) =>
        `<div><span class="stat-label ${k}" style="display:inline-flex"><span class="dot"></span>${v.label}</span><b>${fmt(best[`final_check_${k}_mape`], 1)}%</b></div>`).join('')}</div>
    </section>
    <div class="controls">
      ${segmented('accPhase', Object.entries(PHASES).map(([k, v]) => [k, v.label]), p, 'Fluid')}
    </div>
    <div class="grid-2">
      <section class="card">
        <div class="card-head"><h2>Estimated vs measured</h2><span class="aside">${pts.length} well tests</span></div>
        <div class="chart" id="ch-scatter"></div>
        <p class="footnote" style="margin:8px 0 0">Points on the dashed line are exact.</p>
      </section>
      <section class="card">
        <div class="card-head"><h2>Error by well</h2><span class="aside">${ph.label}</span></div>
        <div class="bars">${errWells.map(w => `<div class="bar-row"><span>${w}</span>
          <span class="track"><span class="fill" style="display:block;width:${100 * (errs[w] || 0) / maxErr}%;background:var(--${p})"></span></span>
          <span class="v">${fmt(errs[w], 1)}%</span></div>`).join('')}</div>
      </section>
    </div>
    <h2 class="section-title">What each set of inputs adds</h2>
    <section class="card">
      ${sel.map(r => `<div class="input-set">
        <h3><span>${SET_LABELS[r.feature_set]}${r.feature_set === D.best.feature_set ? '<span class="badge">In use</span>' : ''}</span>
          <span>${fmt(r.final_check_mean_mape, 1)}%</span></h3>
        <p>${SET_DETAIL[r.feature_set]} ${MODEL_LABELS[r.chosen_model] || r.chosen_model}.</p>
        <div class="bars">${Object.entries(PHASES).map(([k, v]) => `<div class="bar-row"><span>${v.label}</span>
          <span class="track"><span class="fill" style="display:block;width:${100 * r[`final_check_${k}_mape`] / maxSet}%;background:var(--${k})"></span></span>
          <span class="v">${fmt(r[`final_check_${k}_mape`], 1)}%</span></div>`).join('')}</div>
      </div>`).join('')}
    </section>
    <section class="card note">
      ${infoIcon}
      <p><b>Not for new wells.</b> The model in use learns each well from that well’s own tests. When a whole
        well is hidden from training, the best error of any model is about ${fmt(D.lowoBest)}%, so use it on
        wells that already have well tests, or upload a new well's tests and recalibrate.</p>
    </section>
    ${checkHtml}`;

  draws.push(() => scatterChart(document.getElementById('ch-scatter'), {
    points: pts, color: cssVar('--' + p), unit: ph.unit, height: 340 }));
  if (ck.length) draws.push(() => scatterChart(document.getElementById('ch-check'), {
    points: ck.map(r => ({ x: r.measured, y: r.predicted, well: r.well, t: r.t })), color: cssVar('--' + p), unit: ph.unit, height: 320 }));
}

function pageBuildups(view) {
  if (!D.pta || !D.pta.length) {
    view.innerHTML = `<header class="page-head"><h1 class="large-title">Build-ups</h1>
      <p class="subtitle">No build-ups in this data. A build-up needs the choke closed to 0% and opened again, with
        the downhole gauge recording, and a fully flowing day before it.</p></header>
      ${(D.source && D.source.warnings || []).filter(w => w.startsWith('Build-up')).map(w => `<p class="footnote">${esc(w)}</p>`).join('')}`;
    return;
  }
  const list = D.pta, b = list[Math.min(state.bu, list.length - 1)], c = b.curves;
  const label = x => `${x.well_name}, ${dShort.format(parseT(x.t_shut))}`;
  const keyNote = (v, d) => v == null ? '' : `Answer key ${fmt(v, d)}`;
  const hasKey = list.some(x => x.key_k_md != null);
  const kc = (v, d) => hasKey ? `<td>${fmt(v, d)}</td>` : '';
  const kh = hasKey ? '<th>Key</th>' : '';
  const tone = b.skin > 3 ? 'warn' : b.skin < -1 ? 'good' : 'ok';
  const inWin = c.dt.map(t => t >= b.window_start_hr && t <= b.window_end_hr);
  const pick = (arr, want) => arr.filter((_, i) => inWin[i] === want);
  const hMax = Math.max(...c.horner);
  const tipPoint = i => `<div class="tip-date">${fmt(c.dt[i], c.dt[i] < 1 ? 2 : 1)} h after shut-in</div>
    <div class="tip-row">Pressure<b>${fmt(c.p[i], 1)} psia</b></div>
    <div class="tip-row">Horner ratio<b>${fmt(c.horner[i])}</b></div>`;

  view.innerHTML = `
    <header class="page-head">
      <h1 class="large-title">Build-ups</h1>
      <p class="subtitle">Horner analysis of each shut-in, treating the reservoir as single-phase oil and using
        the model's predicted oil rate before the shut-in.</p>
    </header>
    <div class="controls">
      <div class="chips" role="group" aria-label="Shut-in">${list.map((x, i) =>
        `<button type="button" class="chip" data-bu="${i}" aria-pressed="${x === b}">${label(x)}</button>`).join('')}</div>
    </div>
    <section class="summary" aria-label="Reservoir properties">
      ${stat('', 'Horner slope', fmt(b.m_psi_cycle, 1), 'psi/cycle', keyNote(b.key_m_psi_cycle, 1))}
      ${stat('oil', 'Permeability', fmt(b.k_md, 1), 'md', keyNote(b.key_k_md, 1))}
      ${stat('', 'Skin', fmt(b.skin, 2), '', keyNote(b.key_skin, 2))}
      ${stat('', 'ΔP skin', fmt(b.dP_skin, 1), 'psi', keyNote(b.key_dP_skin, 1))}
    </section>
    <p class="footnote">Predicted oil rate before shut-in ${fmt(b.q_pred_stbd)} STB/d (${dLong.format(parseT(b.q_date))}).
      Producing time ${fmt(b.tp_hr)} h. Flowing pressure at shut-in ${fmt(b.pwf_psia, 1)} psia.
      Shut in for ${fmt(b.duration_hr, 1)} h; radial flow taken from ${fmt(b.window_start_hr, 1)} to ${fmt(b.window_end_hr, 1)} h.</p>
    ${b.notes ? `<section class="card reading ${tone}">
      <div class="card-head"><h2>${esc(b.interpretation)}</h2>
        ${API && b.plot ? `<a class="link" href="${api('plots/' + b.plot)}?dl=1" download>Download plot</a>` : ''}</div>
      <ul>${b.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>
    </section>` : ''}
    <section class="card">
      <div class="card-head"><h2>Horner plot</h2><span class="aside">m = ${fmt(b.m_psi_cycle, 1)} psi/cycle</span></div>
      <div class="chart" id="ch-horner"></div>
      <div class="legend">
        <span><i style="background:var(--tertiary);width:9px;height:9px;border-radius:50%"></i>Build-up pressure</span>
        <span><i style="background:var(--oil);width:9px;height:9px;border-radius:50%"></i>Radial-flow window</span>
        <span><i style="background:var(--tint)"></i>Horner straight line</span>
      </div>
    </section>
    <section class="card">
      <div class="card-head"><h2>Log-log diagnostic plot</h2><span class="aside">psi vs hours</span></div>
      <div class="chart" id="ch-loglog"></div>
      <div class="legend">
        <span><i style="background:var(--label);width:9px;height:9px;border-radius:50%"></i>Pressure change Δp</span>
        <span><i style="background:var(--oil);width:9px;height:9px;border-radius:50%"></i>Derivative</span>
        <span><i class="band" style="background:var(--oil)"></i>Radial-flow window, where the derivative is flat</span>
        <span><i style="background:var(--tint)"></i>m / 2.303</span>
      </div>
    </section>
    <h2 class="section-title">${hasKey ? 'All build-ups against the answer key' : 'All build-ups'}</h2>
    <section class="card" style="padding:0 0 4px">
      <div class="table-wrap" style="margin:0;max-height:none"><table>
        <thead><tr><th>Shut-in</th><th>Duration</th><th>Predicted oil</th><th>Slope m</th>${kh}
          <th>k, md</th>${kh}<th>Skin</th>${kh}<th>ΔP skin</th>${kh}<th>p*, psia</th><th class="wrap">Reading</th></tr></thead>
        <tbody>${list.map(x => `<tr>
          <td>${label(x)}</td><td>${fmt(x.duration_hr, 1)} h</td><td>${fmt(x.q_pred_stbd)}</td>
          <td>${fmt(x.m_psi_cycle, 1)}</td>${kc(x.key_m_psi_cycle, 1)}
          <td>${fmt(x.k_md, 1)}</td>${kc(x.key_k_md, 1)}
          <td>${fmt(x.skin, 2)}</td>${kc(x.key_skin, 2)}
          <td>${fmt(x.dP_skin, 1)}</td>${kc(x.key_dP_skin, 1)}
          <td>${fmt(x.p_star_psia)}</td><td class="wrap">${esc(x.interpretation || '')}</td></tr>`).join('')}</tbody>
      </table></div>
    </section>
    ${hasKey ? `<section class="card note">
      ${infoIcon}
      <p><b>The answer key is only for comparison.</b> It comes from <code>pta_results.csv</code> and is never used
        in the calculation. The slopes agree within about 2%, because both use the same pressure data. Permeability
        differs a little more, because it scales with the oil rate and ours is predicted, not measured.</p>
    </section>` : ''}`;

  draws.push(() => {
    const oil = cssVar('--oil'), grey = cssVar('--tertiary'), tint = cssVar('--tint'), ink = cssVar('--label');
    const [sl, ic] = c.line;
    xyChart(document.getElementById('ch-horner'), {
      id: 'horner', label: 'Horner plot', xLog: true, xReverse: true, height: 340,
      xLabel: 'Horner time ratio (tp + Δt) / Δt', yLabel: 'Downhole pressure, psia',
      layers: [
        { name: 'out', x: pick(c.horner, false), y: pick(c.p, false), color: grey, r: 3 },
        { name: 'win', x: pick(c.horner, true), y: pick(c.p, true), color: oil, r: 3.5 },
        { name: 'line', kind: 'line', x: [1, hMax * 1.5], y: [ic, sl * Math.log10(hMax * 1.5) + ic], color: tint },
      ],
      tip: (l, i) => tipPoint(c.horner.indexOf(l.x[i])),
    });
    const dp = c.p.map(v => v - b.pwf_psia);
    xyChart(document.getElementById('ch-loglog'), {
      id: 'loglog', label: 'Log-log diagnostic plot', xLog: true, yLog: true, height: 320,
      xLabel: 'Time since shut-in Δt, hours', yLabel: 'psi',
      band: [b.window_start_hr, b.window_end_hr], hline: { y: b.m_psi_cycle / 2.303 },
      layers: [
        { name: 'dp', x: c.dt, y: dp, color: ink, r: 2.6 },
        { name: 'der', x: c.der_t, y: c.der, color: oil, r: 3 },
      ],
      tip: (l, i) => `<div class="tip-date">${fmt(l.x[i], l.x[i] < 1 ? 2 : 1)} h after shut-in</div>
        <div class="tip-row">${l.name === 'dp' ? 'Pressure change' : 'Derivative'}<b>${fmt(l.y[i], 1)} psi</b></div>`,
    });
  });
}

// ---- Data: upload raw files -------------------------------------------------------
const FILE_KINDS = [
  { role: 'sensors', label: 'Sensor readings', need: true, cols: ['timestamp', 'well_name', 'whp_psia', 'dh_pressure_psia'],
    hint: '1-minute pressures, temperature and gas-lift rate per well' },
  { role: 'well_tests', label: 'Well tests', need: false, cols: ['well_name', 'test_start', 'test_end', 'oil_rate_stbd'],
    hint: 'Measured rates. Used to check the model, or to recalibrate it' },
  { role: 'answer_key', label: 'PTA answer key', need: false, cols: ['well_name', 't_shut', 'k_md'],
    hint: 'Only shown next to the results for comparison' },
  { role: 'choke', label: 'Choke events', need: true, cols: ['timestamp', 'well_name', 'choke_opening_pct'],
    hint: 'Choke changes; closures to 0% are the build-ups' },
  { role: 'pvt', label: 'Reservoir and fluid properties', need: false, cols: ['well_name', 'porosity_frac', 'oil_fvf_rb_stb'],
    hint: 'Porosity, compressibility, Bo, viscosity, net pay. Needed for permeability and skin' },
  { role: 'completion', label: 'Well completion', need: false, cols: ['well_name', 'gauge_tvd_ft'],
    hint: 'Gauge depth, tubing size, solution GOR' },
];
const upload = { files: [], roles: {}, recal: false, job: null, sent: 0, error: null };

async function detectRole(file) {
  if (/\.zip$/i.test(file.name)) return 'zip';
  const head = (await file.slice(0, 4096).text()).split(/\r?\n/)[0].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
  const kind = FILE_KINDS.find(k => k.cols.every(c => head.includes(c)));
  return kind ? kind.role : null;
}

async function addFiles(list) {
  for (const f of list) {
    if (!/\.(csv|zip)$/i.test(f.name)) continue;
    upload.files = upload.files.filter(x => x.name !== f.name).concat(f);
    upload.roles[f.name] = await detectRole(f);
  }
  upload.error = null;
  render();
}

function uploadReady() {
  const roles = Object.values(upload.roles);
  if (roles.includes('zip')) return true;          // contents are checked on the server
  return FILE_KINDS.filter(k => k.need).every(k => roles.includes(k.role));
}

function startUpload() {
  const fd = new FormData();
  upload.files.forEach(f => fd.append('files', f));
  fd.append('recalibrate', upload.recal && Object.values(upload.roles).some(r => r === 'well_tests' || r === 'zip'));
  const total = upload.files.reduce((s, f) => s + f.size, 0);
  upload.job = { state: 'uploading', step: 0, steps: [], total };
  upload.error = null;
  render();
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/runs');
  xhr.upload.onprogress = e => {
    upload.sent = e.loaded;
    const bar = document.getElementById('up-bar');
    if (bar) bar.style.width = `${100 * e.loaded / (e.total || total)}%`;
    const txt = document.getElementById('up-text');
    if (txt) txt.textContent = `Uploading ${bytes(e.loaded)} of ${bytes(e.total || total)}`;
  };
  xhr.onload = () => {
    let res = {};
    try { res = JSON.parse(xhr.responseText); } catch (_) { /* not JSON */ }
    if (xhr.status !== 202) { upload.job = null; upload.error = res.error || `Upload failed (${xhr.status}).`; return render(); }
    upload.job = { id: res.id, state: 'running', step: 0, steps: [] };
    poll(res.id);
  };
  xhr.onerror = () => { upload.job = null; upload.error = 'The upload did not reach the app. Is python3 app.py still running?'; render(); };
  xhr.send(fd);
}

async function poll(id) {
  const r = await fetch(`/api/runs/${id}/status`).then(x => x.json()).catch(() => null);
  if (!r) { setTimeout(() => poll(id), 1500); return; }
  upload.job = r;
  if (r.state === 'running') { if (state.page === 'data') render(); setTimeout(() => poll(id), 700); return; }
  if (r.state === 'failed') { upload.error = r.error; upload.job = null; return render(); }
  await loadRun(id);
  upload.files = []; upload.roles = {}; upload.job = null; upload.recal = false;
  render();
}

async function loadRun(id) {
  const d = await fetch(`/api/runs/${id}/data`).then(x => { if (!x.ok) throw new Error(); return x.json(); });
  D = d; RUN = id; WELLS = Object.keys(D.wells).sort();
  if (!WELLS.includes(state.well)) state.well = WELLS[0];
  state.bu = 0; sensorCache.clear();
  const u = new URL(location.href);
  if (id === 'sample') u.searchParams.delete('run'); else u.searchParams.set('run', id);
  history.replaceState(null, '', u);
}

function pageData(view) {
  const src = D.source || { name: 'Hackathon field data', files: [], warnings: [] };
  const days = D.wells[WELLS[0]].date;
  const roles = Object.values(upload.roles);
  const hasTests = roles.includes('well_tests') || roles.includes('zip');
  const job = upload.job;
  const check = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2.5 7.5 5.5 10.5 11.5 3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  let body;
  if (!API) {
    body = `<section class="card note">${infoIcon}<p><b>Uploading needs the app running.</b> Start it from the project folder with
      <code>python3 app.py</code> and open <code>http://127.0.0.1:8000</code>. The hackathon results below work without it.</p></section>`;
  } else if (job) {
    const pct = job.state === 'uploading' ? 0 : 100 * job.step / job.steps.length;
    body = `<section class="card progress" aria-live="polite">
      <div class="card-head"><h2>${job.state === 'uploading' ? 'Uploading' : 'Processing'}</h2>
        <span class="aside">${job.state === 'uploading' ? '' : `Step ${Math.max(job.step, 1)} of ${job.steps.length}`}</span></div>
      ${job.state === 'uploading'
        ? `<div class="meter"><span id="up-bar" style="width:${100 * upload.sent / (job.total || 1)}%"></span></div>
           <p class="footnote" id="up-text">Uploading ${bytes(upload.sent)} of ${bytes(job.total)}</p>`
        : `<div class="meter"><span style="width:${pct}%"></span></div>
           <ol class="steps">${job.steps.map((s, i) => `<li class="${i + 1 < job.step ? 'done' : i + 1 === job.step ? 'now' : ''}">
             <span class="mark">${i + 1 < job.step ? check : ''}</span>${s}</li>`).join('')}</ol>`}
    </section>`;
  } else {
    body = `
    <label class="drop card" id="drop">
      <input type="file" id="file-in" multiple accept=".csv,.zip" hidden>
      <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true"><path d="M17 23V7m0 0-6 6m6-6 6 6M7 22v4a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span class="drop-title">Drop CSV or ZIP files here</span>
      <span class="drop-sub">or <u>choose files</u>. Files are recognised by their columns, so any names work.</span>
    </label>
    ${upload.error ? `<section class="card note error" role="alert">${infoIcon}<p><b>Could not process the data.</b> ${esc(upload.error)}</p></section>` : ''}
    <section class="list files" aria-label="Expected files">
      ${['sensors', 'choke', 'pvt', 'completion', 'well_tests', 'answer_key'].map(r => FILE_KINDS.find(k => k.role === r)).map(k => {
        const f = upload.files.find(x => upload.roles[x.name] === k.role);
        return `<div class="frow ${f ? 'have' : ''}">
          <span class="fmark">${f ? check : ''}</span>
          <span><span class="row-title">${k.label}</span>${k.need ? '' : '<span class="opt">Optional</span>'}
            <span class="row-detail">${f ? esc(f.name) + ', ' + bytes(f.size) : k.hint}</span></span>
          ${f ? `<button type="button" class="link" data-remove="${esc(f.name)}">Remove</button>` : ''}
        </div>`;
      }).join('')}
      ${upload.files.filter(f => !FILE_KINDS.some(k => k.role === upload.roles[f.name])).map(f => `<div class="frow ${upload.roles[f.name] === 'zip' ? 'have' : 'bad'}">
          <span class="fmark">${upload.roles[f.name] === 'zip' ? check : '!'}</span>
          <span><span class="row-title">${esc(f.name)}</span>
            <span class="row-detail">${upload.roles[f.name] === 'zip' ? 'ZIP archive, ' + bytes(f.size) + '. The CSV files inside are sorted out on upload' : 'Columns not recognised, so this file will be ignored'}</span></span>
          <button type="button" class="link" data-remove="${esc(f.name)}">Remove</button></div>`).join('')}
    </section>
    <div class="run-bar">
      <label class="toggle ${hasTests ? '' : 'off'}">
        <input type="checkbox" id="recal" ${upload.recal ? 'checked' : ''} ${hasTests ? '' : 'disabled'}>
        <span class="switch" aria-hidden="true"></span>
        <span><b>Recalibrate on the uploaded well tests</b><br><span class="row-detail">Use for wells the model has not seen. Without it the saved model is used as is.</span></span>
      </label>
      <button type="button" class="btn" id="run" ${uploadReady() ? '' : 'disabled'}>Process data</button>
    </div>`;
  }

  view.innerHTML = `
    <header class="page-head">
      <h1 class="large-title">Data</h1>
      <p class="subtitle">Upload raw well data. The trained model estimates daily oil, water and gas, and every
        shut-in is analysed as a build-up test.</p>
    </header>
    <section class="card current">
      <div>
        <div class="stat-label">Showing</div>
        <div class="current-name">${esc(src.name)}</div>
        <div class="row-detail">${WELLS.length} wells, ${days.length} days, ${D.pta.length} build-ups analysed${src.recalibrated ? ', model recalibrated on uploaded tests' : ''}</div>
      </div>
      ${RUN !== 'sample' && API ? '<button type="button" class="btn plain" id="to-sample">Show hackathon data</button>' : ''}
      ${src.warnings && src.warnings.length ? `<ul class="warnings">${src.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    </section>
    ${body}
    <h2 class="section-title">The trained model</h2>
    <section class="card note">${infoIcon}<p><b>${esc(D.model ? D.model.name : 'Well-calibrated model')}.</b>
      Trained on ${D.model ? D.model.trained_on_tests : ''} well tests of ${D.model ? D.model.wells.join(', ') : ''}
      and saved as <code>models/vfm_model.pkl</code>. On July to September tests it had not seen, the average error
      was ${fmt(D.best.mape, 1)}%. It learns each well from that well's own tests, so for a new well upload its well
      tests and turn on recalibration.</p></section>`;

  if (!API || job) return;
  const input = document.getElementById('file-in'), drop = document.getElementById('drop');
  input.addEventListener('change', () => addFiles([...input.files]));
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => addFiles([...e.dataTransfer.files]));
  document.getElementById('recal').addEventListener('change', e => { upload.recal = e.target.checked; });
  document.getElementById('run').addEventListener('click', startUpload);
}

// ---- Sensors: hourly field measurements ------------------------------------------------
const sensorCache = new Map();
const SENSORS = [
  { k: 'dh_pressure_psia', label: 'Downhole pressure', unit: 'psia', color: '--w3' },
  { k: 'whp_psia', label: 'Wellhead pressure', unit: 'psia', color: '--w1', extra: { k: 'whp_downstream_psia', label: 'Downstream of choke' } },
  { k: 'annulus_pressure_psia', label: 'Annulus pressure', unit: 'psia', color: '--w6' },
  { k: 'gas_lift_rate_mscfd', label: 'Gas-lift injection', unit: 'Mscf/d', color: '--gas' },
  { k: 'dh_temperature_degf', label: 'Downhole temperature', unit: '°F', color: '--w5', digits: 1 },
  { k: 'choke_opening_pct', label: 'Choke opening', unit: '%', color: '--w2' },
];
const S_RANGES = [['1W', 7], ['1M', 30], ['3M', 91], ['All', Infinity]];

function pageSensors(view) {
  const head = `<header class="page-head">
      <h1 class="large-title">Sensors</h1>
      <p class="subtitle">Hourly averages of the field measurements after cleaning: error codes and impossible values removed.</p>
    </header>
    <div class="controls">
      <div class="chips" role="group" aria-label="Well">${WELLS.map(w =>
        `<button type="button" class="chip" data-well="${w}" aria-pressed="${w === state.well}">${w}</button>`).join('')}</div>
      ${segmented('sRange', S_RANGES.map(r => [r[0], r[0]]), state.sRange, 'Time range')}
    </div>`;
  if (!API) {
    view.innerHTML = head + `<section class="card note">${infoIcon}<p><b>Sensor charts need the app running.</b>
      Start it with <code>python3 app.py</code>.</p></section>`;
    return;
  }
  const key = `${RUN}/${state.well}`, data = sensorCache.get(key);
  if (!data) {
    view.innerHTML = head + '<section class="card"><p class="footnote">Loading sensor data…</p></section>';
    fetch(api(`sensors/${state.well}`)).then(r => r.json()).then(j => {
      sensorCache.set(key, j.error ? { error: j.error } : { ...j, x: j.t.map(parseT) });
      if (state.page === 'sensors') render();
    });
    return;
  }
  if (data.error) { view.innerHTML = head + `<section class="card note">${infoIcon}<p>${esc(data.error)}</p></section>`; return; }

  const days = S_RANGES.find(r => r[0] === state.sRange)[1], last = data.x[data.x.length - 1];
  const start = days === Infinity ? -Infinity : last - days * DAY;
  const idx = data.x.map((t, i) => t > start ? i : -1).filter(i => i >= 0);
  const x = idx.map(i => data.x[i]), col = k => data[k] ? idx.map(i => data[k][i]) : x.map(() => null);
  const choke = col('choke_opening_pct');
  const bands = choke.map((c, i) => c != null && c < 1 ? { x: x[i], a: .28 } : null).filter(Boolean);
  const shutHours = bands.length;
  const coverage = 100 * col('dh_pressure_psia').filter(v => v != null).length / Math.max(x.length, 1);
  const avg = k => mean(col(k).filter((v, i) => choke[i] == null || choke[i] >= 1));

  view.innerHTML = head + `
    <section class="summary" aria-label="Averages while flowing">
      ${stat('', 'Downhole pressure', fmt(avg('dh_pressure_psia')), 'psia', 'Average while flowing')}
      ${stat('', 'Wellhead pressure', fmt(avg('whp_psia')), 'psia', 'Average while flowing')}
      ${stat('gas', 'Gas-lift injection', fmt(avg('gas_lift_rate_mscfd')), 'Mscf/d')}
      ${stat('', 'Shut in', fmt(shutHours), shutHours === 1 ? 'hour' : 'hours', `Downhole gauge reported ${fmt(coverage, 1)}% of hours`)}
    </section>
    <p class="footnote">${dTime.format(x[0])} to ${dTime.format(x[x.length - 1])}. Grey bands are hours with the choke closed;
      the pressure rise in them is the build-up used on the Build-ups page.</p>
    <div class="grid-even">
      ${SENSORS.map(se => `<section class="card">
        <div class="card-head"><h2>${se.label}</h2><span class="unit">${se.unit}</span></div>
        <div class="chart" id="sn-${se.k}"></div>
        ${se.extra ? `<div class="legend"><span><i style="background:var(${se.color})"></i>Upstream</span><span><i class="dash"></i>${se.extra.label}</span></div>` : ''}
      </section>`).join('')}
    </div>`;

  draws.push(() => SENSORS.forEach(se => {
    const series = [{ name: se.label, y: col(se.k), color: cssVar(se.color), width: 1.4 }];
    if (se.extra) series.push({ name: se.extra.label, y: col(se.extra.k), color: cssVar('--secondary'), width: 1.2, dash: true });
    lineChart(document.getElementById('sn-' + se.k), { id: 'sn-' + se.k, label: se.label, x, series, bands,
      step: HOUR, fitY: true, digits: se.digits || 0, height: 190 });
  }));
}

// ---- Export: result files and reports ---------------------------------------------------
function pageExport(view) {
  const head = `<header class="page-head">
      <h1 class="large-title">Export</h1>
      <p class="subtitle">Result files and reports for ${esc((D.source || {}).name || 'this data')}.</p>
    </header>`;
  if (!API) {
    view.innerHTML = head + `<section class="card note">${infoIcon}<p><b>Downloads need the app running.</b> Start it with
      <code>python3 app.py</code>. The same files are in the <code>results/</code> and <code>pta_plots/</code> folders.</p></section>`;
    return;
  }
  if (!exportCache.has(RUN)) {
    view.innerHTML = head + '<section class="card"><p class="footnote">Loading…</p></section>';
    fetch(api('exports')).then(r => r.json()).then(j => { exportCache.set(RUN, j); if (state.page === 'export') render(); });
    return;
  }
  const ex = exportCache.get(RUN), byName = Object.fromEntries(ex.files.map(f => [f.name, f]));
  const kind = n => n.split('.').pop().toUpperCase();
  const fileRow = n => byName[n] ? `<a class="frow have dl" href="${api('files/' + n)}" download>
      <span class="ftype">${kind(n)}</span>
      <span><span class="row-title">${byName[n].label}</span><span class="row-detail">${n}, ${bytes(byName[n].size)}</span></span>
      <span class="link">Download</span></a>` : '';
  view.innerHTML = head + `
    <section class="card everything">
      <div><h2>Everything</h2><p class="row-detail">Result files, reports and all build-up plots in one ZIP.</p></div>
      <a class="btn" href="${api('bundle.zip')}" download>Download ZIP</a>
    </section>
    <h2 class="section-title">Flow rates (VFM)</h2>
    <section class="list files">${['vfm_submission.csv', 'daily_rates.csv', 'vfm_report.xlsx', 'vfm_report.pdf', 'vfm_model_recalibrated.pkl'].map(fileRow).join('')}</section>
    <h2 class="section-title">Build-ups (PTA)</h2>
    <section class="list files">${['pta_submission.csv', 'pta_results_detailed.csv', 'pta_report.pdf'].map(fileRow).join('') ||
      '<div class="frow"><span></span><span class="row-detail">No build-ups could be analysed in this data.</span></div>'}</section>
    ${ex.plots.length ? `<h2 class="section-title">Build-up plots</h2>
    <div class="plots">${ex.plots.map(p => `<figure class="card">
      <a href="${api('plots/' + p)}" target="_blank" rel="noopener"><img src="${api('plots/' + p)}" alt="Horner and log-log plots, ${p.replace('.png', '').replace('_', ' ')}" loading="lazy"></a>
      <figcaption><span>${plotName(p)}</span><a class="link" href="${api('plots/' + p)}?dl=1" download>PNG</a></figcaption>
    </figure>`).join('')}</div>` : ''}`;
}
const exportCache = new Map();
const plotName = f => { const [w, d] = f.replace('.png', '').split('_');
  return d && d.length === 8 ? `${w}, ${dLong.format(parseT(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`))}` : f; };

// ---- Router ----------------------------------------------------------------------
const view = document.getElementById('view');

const PAGES = { data: pageData, sensors: pageSensors, wells: pageWells, field: pageField,
                accuracy: pageAccuracy, buildups: pageBuildups, export: pageExport };

function render() {
  draws = [];
  document.querySelectorAll('.nav-seg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === state.page));
  PAGES[state.page](view);
  draws.forEach(f => f());
  const perWell = state.page === 'wells' || state.page === 'sensors';
  history.replaceState(null, '', `${location.search}#${state.page}${perWell ? '/' + state.well : ''}`);
  const titles = { data: 'Data', sensors: `${state.well} sensors`, field: 'Field', accuracy: 'Accuracy', buildups: 'Build-ups', export: 'Export' };
  document.title = `${state.page === 'wells' ? state.well : titles[state.page]} – Flow Meter`;
}

function go(changes, { scrollTop = false } = {}) {
  Object.assign(state, changes);
  render();
  if (scrollTop) {
    window.scrollTo({ top: 0 });
    view.classList.remove('enter'); void view.offsetWidth; view.classList.add('enter');
  }
}

document.addEventListener('click', e => {
  const seg = e.target.closest('[data-seg] button');
  if (seg) {
    const name = seg.parentElement.dataset.seg;
    return go({ [name]: seg.dataset.v }, { scrollTop: name === 'page' });
  }
  const chip = e.target.closest('[data-well]');
  if (chip) return go({ well: chip.dataset.well });
  const bu = e.target.closest('[data-bu]');
  if (bu) return go({ bu: Number(bu.dataset.bu) });
  const row = e.target.closest('[data-goto]');
  if (row) return go({ page: 'wells', well: row.dataset.goto }, { scrollTop: true });
  const rm = e.target.closest('[data-remove]');
  if (rm) {
    e.preventDefault();
    upload.files = upload.files.filter(f => f.name !== rm.dataset.remove);
    delete upload.roles[rm.dataset.remove];
    return render();
  }
  if (e.target.closest('#to-sample')) return loadRun('sample').then(() => render());
});

let resizeTimer;
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => draws.forEach(f => f()), 120); }).observe(view);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);

const [hp, hw] = location.hash.slice(1).split('/');
if (hp in PAGES) state.page = hp;
if (WELLS.includes(hw)) state.well = hw;
const startRun = new URLSearchParams(location.search).get('run');
if (API && startRun) loadRun(startRun).catch(() => loadRun('sample')).finally(render);
else render();
