/* Plot page: build your own charts from any daily rate, cumulative, ratio, sensor or well-test series.
   Uses ECharts (web/echarts.min.js). Shares globals with app.js (D, WELLS, RUN, esc, fmt, cssVar, parseT, …),
   which are only read when the page is drawn, so this file can load before app.js. */
'use strict';

const Plot = (() => {
  const DAYMS = 864e5;
  const STORE = 'flowmeter.plots.v1';
  const AXW = 58;          // width reserved for each extra y axis
  const ZX = 22;           // height of the date range bar under the chart
  const ZY = 10;           // width of the value range bar beside the chart

  // ---- Units: how each one is drawn ---------------------------------------------------
  const UNITS = {
    'STB/d': { zero: true, d: 1 }, 'Mscf/d': { zero: true, d: 1 }, STB: { zero: true, d: 0 },
    Mscf: { zero: true, d: 0 }, '%': { zero: true, d: 1 }, 'scf/STB': { zero: false, d: 0 },
    ratio: { zero: true, d: 3 }, psia: { zero: false, d: 1 }, psi: { zero: false, d: 1 }, '°F': { zero: false, d: 1 },
  };

  // ---- Array helpers ---------------------------------------------------------------------
  const nulls = n => new Array(n).fill(null);
  const cum = a => { let s = 0, seen = false; return a.map(v => { if (v != null) { s += v; seen = true; } return seen ? s : null; }); };
  const ratio = (n, d, f = 1) => n.map((v, i) => v == null || d[i] == null || d[i] <= 0 ? null : f * v / d[i]);
  const add = (a, b) => a.map((v, i) => v == null && b[i] == null ? null : (v || 0) + (b[i] || 0));
  const sub = (a, b) => a.map((v, i) => v == null || b[i] == null ? null : v - b[i]);
  const scale = (a, f) => a.map(v => v == null ? null : v * f);

  // ---- Variables -----------------------------------------------------------------------
  // kind 'daily': one value per well-day (sums / ratios are recomputed for manifolds and the field)
  // kind 'test' : measured well tests, wells only
  const GROUPS = [['rate', 'Rates'], ['cum', 'Cumulative'], ['ratio', 'Ratios'], ['sensor', 'Sensors'], ['test', 'Well tests']];
  const VARS = [
    { k: 'q_oil', label: 'Q oil', unit: 'STB/d', group: 'rate', needs: ['oil'], get: b => b.oil },
    { k: 'q_water', label: 'Q water', unit: 'STB/d', group: 'rate', needs: ['water'], get: b => b.water },
    { k: 'q_liquid', label: 'Q liquid', unit: 'STB/d', group: 'rate', needs: ['oil', 'water'], get: b => add(b.oil, b.water) },
    { k: 'q_gas', label: 'Q gas', unit: 'Mscf/d', group: 'rate', needs: ['gas'], get: b => b.gas, desc: 'Formation gas, without lift gas' },
    { k: 'q_lift', label: 'Gas lift', unit: 'Mscf/d', group: 'rate', needs: ['lift'], get: b => b.lift },
    { k: 'q_total', label: 'Q total gas', unit: 'Mscf/d', group: 'rate', needs: ['total'], get: b => b.total, desc: 'Formation gas + lift gas' },
    { k: 'cq_oil', label: 'CQ oil', unit: 'STB', group: 'cum', needs: ['oil'], get: b => cum(b.oil), desc: 'Since 1 Jan 2025' },
    { k: 'cq_water', label: 'CQ water', unit: 'STB', group: 'cum', needs: ['water'], get: b => cum(b.water), desc: 'Since 1 Jan 2025' },
    { k: 'cq_gas', label: 'CQ gas', unit: 'Mscf', group: 'cum', needs: ['gas'], get: b => cum(b.gas), desc: 'Since 1 Jan 2025' },
    { k: 'cq_lift', label: 'CQ gas lift', unit: 'Mscf', group: 'cum', needs: ['lift'], get: b => cum(b.lift), desc: 'Since 1 Jan 2025' },
    { k: 'np', label: 'Cum oil since first production', unit: 'STB', group: 'cum', needs: ['oil'], info: 'cum0',
      get: (b, st) => st.cum0 == null ? nulls(b.oil.length) : cum(b.oil).map(v => v == null ? null : v + st.cum0) },
    { k: 'wc', label: 'WC', unit: '%', group: 'ratio', needs: ['oil', 'water'], get: b => ratio(b.water, add(b.oil, b.water), 100), desc: 'Water cut' },
    { k: 'gor', label: 'GOR', unit: 'scf/STB', group: 'ratio', needs: ['gas', 'oil'], get: b => ratio(b.gas, b.oil, 1000) },
    { k: 'wor', label: 'WOR', unit: 'ratio', group: 'ratio', needs: ['water', 'oil'], get: b => ratio(b.water, b.oil) },
    { k: 'glr', label: 'GLR with lift gas', unit: 'scf/STB', group: 'ratio', needs: ['total', 'oil', 'water'], get: b => ratio(b.total, add(b.oil, b.water), 1000) },
    { k: 'rf', label: 'RF (estimate)', unit: '%', group: 'ratio', needs: ['oil'], info: 'ooip',
      desc: 'Cum oil since first production ÷ volumetric oil in place (drainage area × pay × porosity × (1 − Sw) ÷ Bo). The drainage areas are rough, so some wells exceed 100%.',
      get: (b, st) => st.ooip == null || st.cum0 == null ? nulls(b.oil.length) : cum(b.oil).map(v => v == null ? null : 100 * (v + st.cum0) / st.ooip) },
    { k: 'uptime', label: 'Uptime', unit: '%', group: 'ratio', needs: ['uptime'], get: b => scale(b.uptime, 100) },
    { k: 'bhp', label: 'BHP', unit: 'psia', group: 'sensor', needs: ['bhp'], get: b => b.bhp, desc: 'Downhole gauge pressure' },
    { k: 'whp', label: 'WHP', unit: 'psia', group: 'sensor', needs: ['whp'], get: b => b.whp },
    { k: 'whp_dn', label: 'WHP downstream', unit: 'psia', group: 'sensor', needs: ['whp_dn'], get: b => b.whp_dn },
    { k: 'ann', label: 'Annulus pressure', unit: 'psia', group: 'sensor', needs: ['ann'], get: b => b.ann },
    { k: 'dp_tub', label: 'Tubing ΔP', unit: 'psi', group: 'sensor', needs: ['bhp', 'whp'], get: b => sub(b.bhp, b.whp), desc: 'BHP − WHP' },
    { k: 'bht', label: 'BHT', unit: '°F', group: 'sensor', needs: ['bht'], get: b => b.bht, desc: 'Downhole gauge temperature' },
    { k: 'choke', label: 'Choke', unit: '%', group: 'sensor', needs: ['choke'], get: b => b.choke },
    { k: 't_oil', label: 'Test oil rate', unit: 'STB/d', group: 'test', tkey: 'oil', pair: 'q_oil' },
    { k: 't_water', label: 'Test water rate', unit: 'STB/d', group: 'test', tkey: 'water', pair: 'q_water' },
    { k: 't_liquid', label: 'Test liquid rate', unit: 'STB/d', group: 'test', tkey: 'liquid', pair: 'q_liquid' },
    { k: 't_gas', label: 'Test gas rate', unit: 'Mscf/d', group: 'test', tkey: 'gas', pair: 'q_gas' },
    { k: 't_wc', label: 'Test WC', unit: '%', group: 'test', tkey: 'wc', pair: 'wc' },
    { k: 't_gor', label: 'Test GOR', unit: 'scf/STB', group: 'test', tkey: 'gor', pair: 'gor' },
    { k: 't_lift', label: 'Test gas lift rate', unit: 'Mscf/d', group: 'test', tkey: 'lift', pair: 'q_lift' },
    { k: 't_bhp', label: 'Test BHP', unit: 'psia', group: 'test', tkey: 'bhp', pair: 'bhp' },
    { k: 't_whp', label: 'Test WHP', unit: 'psia', group: 'test', tkey: 'whp', pair: 'whp' },
  ];
  const V = Object.fromEntries(VARS.map(v => [v.k, v]));
  const BASE = ['oil', 'water', 'gas', 'lift', 'total', 'uptime', 'bhp', 'whp', 'whp_dn', 'ann', 'bht', 'choke'];
  const SUMMED = new Set(['oil', 'water', 'gas', 'lift', 'total']);

  // ---- Data model (rebuilt when a different run is loaded) ---------------------------------
  let M = null;
  function model() {
    if (M && M.D === D) return M;
    const dates = [...new Set(Object.values(D.wells).flatMap(w => w.date))].sort();
    const idx = new Map(dates.map((d, i) => [d, i]));
    const ts = dates.map(d => parseT(d) + 12 * 36e5);          // a daily value sits at midday
    const wells = {};
    for (const [w, o] of Object.entries(D.wells)) {
      const b = {};
      for (const k of BASE) {
        const a = nulls(dates.length);
        if (o[k]) o.date.forEach((d, i) => { a[idx.get(d)] = o[k][i]; });
        b[k] = a; b['has_' + k] = !!o[k];
      }
      wells[w] = b;
    }
    const info = D.info || {};
    const manifolds = [...new Set(Object.keys(wells).map(w => info[w] && info[w].manifold).filter(Boolean))].sort();
    const testKeys = new Set(Object.values(D.tests || {}).flatMap(list => list.flatMap(r => Object.keys(r))));
    M = { D, dates, idx, ts, wells, info, manifolds, testKeys, base: new Map(), vals: new Map() };
    return M;
  }
  const wellIds = () => Object.keys(model().wells).sort();
  const isWell = id => id in model().wells;
  const entLabel = id => id === 'F' ? 'Field' : id.startsWith('M:') ? 'Manifold ' + id.slice(2) : id;
  function members(id) {
    const m = model();
    if (isWell(id)) return [id];
    if (id === 'F') return wellIds();
    return wellIds().filter(w => m.info[w] && m.info[w].manifold === id.slice(2));
  }
  function baseOf(id) {
    const m = model();
    if (m.base.has(id)) return m.base.get(id);
    let b;
    if (isWell(id)) b = m.wells[id];
    else {
      const ws = members(id).map(w => m.wells[w]);
      b = {};
      for (const k of BASE) {
        b[k] = m.dates.map((_, i) => {
          const vs = ws.map(w => w[k][i]).filter(v => v != null);
          if (!vs.length) return null;
          const s = vs.reduce((x, y) => x + y, 0);
          return SUMMED.has(k) ? s : s / vs.length;
        });
        b['has_' + k] = ws.some(w => w['has_' + k]);
      }
    }
    m.base.set(id, b);
    return b;
  }
  function staticOf(id) {
    const m = model(), ws = members(id).map(w => m.info[w] || {});
    const total = k => ws.length && ws.every(x => x[k] != null) ? ws.reduce((s, x) => s + x[k], 0) : null;
    return { cum0: total('cum0'), ooip: total('ooip') };
  }
  function available(vk) {
    const v = V[vk], m = model();
    if (v.tkey) return m.testKeys.has(v.tkey);
    if (v.info && !Object.values(m.info).some(x => x[v.info] != null)) return false;
    return v.needs.every(k => Object.values(m.wells).some(w => w['has_' + k]));
  }
  function daily(id, vk) {
    const m = model(), key = id + '|' + vk;
    if (!m.vals.has(key)) m.vals.set(key, V[vk].get(baseOf(id), staticOf(id)));
    return m.vals.get(key);
  }
  function tests(id, vk) {
    const t = (D.tests || {})[id] || [], k = V[vk].tkey;
    return t.filter(r => r[k] != null).map(r => ({ t: parseT(r.t), d: r.t.slice(0, 10), v: r[k], rec: r }));
  }

  // ---- Chart configs (kept in memory and in this browser) ----------------------------------
  const DEFAULTS = {
    fontFamily: 'system', fontSize: 12, lineWidth: 1.6, lineStyle: 'solid', markers: false, smooth: false,
    testSize: 7, height: 460, grid: true, splitAxes: false, logY: false, colors: {},
    margin: { t: 52, r: 8, b: 8, l: 8 }, v: 2,
  };
  const FONTS = {
    system: ['System', '-apple-system, BlinkMacSystemFont, "Helvetica Neue", system-ui, sans-serif'],
    arial: ['Arial', 'Arial, Helvetica, sans-serif'],
    verdana: ['Verdana', 'Verdana, Geneva, sans-serif'],
    serif: ['Georgia', 'Georgia, "Times New Roman", serif'],
    mono: ['Monospace', '"SF Mono", Menlo, Consolas, monospace'],
  };
  const clone = o => JSON.parse(JSON.stringify(o));
  let seq = 0;
  const newId = () => 'c' + Date.now().toString(36) + (seq++);
  function defaultChart() {
    const w = wellIds()[0];
    return { id: newId(), title: '', x: 'date', entities: w ? [w] : [], vars: ['q_oil', 't_oil', 'wc', 't_wc'],
             hidden: {}, settings: clone(DEFAULTS), pickOpen: true };
  }
  let charts = null;
  function load() {
    if (charts) return;
    try { charts = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) { charts = null; }
    if (!Array.isArray(charts) || !charts.length) charts = [defaultChart()];
    charts.forEach(c => {
      c.settings = { ...clone(DEFAULTS), ...(c.settings || {}) };
      c.settings.margin = { ...DEFAULTS.margin, ...(c.settings.margin || {}) };
      if (!c.settings.v || c.settings.v < 2) {          // charts saved before the cleaner look: move untouched defaults
        const mg = c.settings.margin;
        if (mg.t === 64 && mg.r === 12 && mg.b === 12 && mg.l === 12) c.settings.margin = clone(DEFAULTS.margin);
        if (+c.settings.testSize === 9) c.settings.testSize = DEFAULTS.testSize;
        c.settings.v = 2;
      }
      c.hidden = c.hidden || {};
    });
  }
  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify(charts.map(c => ({ id: c.id, title: c.title, x: c.x, entities: c.entities,
        vars: c.vars, hidden: c.hidden, settings: c.settings, pickOpen: c.pickOpen, openGroups: c.openGroups }))));
    } catch (e) { /* storage blocked: charts still work for this visit */ }
  }
  function autoTitle(c) {
    const es = c.entities.map(entLabel);
    const who = !es.length ? 'No data picked' : es.length <= 3 ? es.join(', ') : `${es.length} wells and groups`;
    return c.x === 'date' ? who : `${who}: against ${V[c.x].label}`;
  }
  const titleOf = c => c.title || autoTitle(c);

  // ---- Series ----------------------------------------------------------------------------
  function seriesOf(c) {
    const m = model(), dateX = c.x === 'date', S = c.settings;
    const pal = Array.from({ length: 10 }, (_, i) => cssVar('--w' + (i + 1)));
    const single = c.entities.length === 1;
    const out = [];
    for (const e of c.entities) {
      if (!isWell(e) && !m.manifolds.length && e !== 'F') continue;
      const xs = dateX ? null : daily(e, c.x);
      for (const vk of c.vars) {
        const v = V[vk];
        if (!v || !available(vk) || (v.tkey && !isWell(e))) continue;
        const id = e + '|' + vk, name = single ? v.label : `${entLabel(e)} ${v.label}`;
        let data;
        if (v.tkey) {
          data = tests(e, vk).map(r => {
            if (dateX) return [r.t, r.v];
            const i = m.idx.get(r.d), x = i == null ? null : xs[i];
            return x == null ? null : [x, r.v, r.t];
          }).filter(Boolean);
        } else {
          const ys = daily(e, vk);
          data = dateX ? ys.map((y, i) => [m.ts[i], y])
                       : ys.map((y, i) => (y == null || xs[i] == null) ? null : [xs[i], y, m.ts[i]]).filter(Boolean);
        }
        if (S.logY) data = data.filter(p => p[1] == null || p[1] > 0);
        out.push({ id, e, vk, v, name, unit: v.unit, test: !!v.tkey, data });
      }
    }
    // Colours: user's choice, else a test shares the colour of its model series, else next in the palette
    let n = 0;
    const byId = {};
    out.filter(s => !s.test).forEach(s => { byId[s.id] = s.color = S.colors[s.id] || pal[n++ % pal.length]; });
    out.filter(s => s.test).forEach(s => { s.color = S.colors[s.id] || byId[s.e + '|' + s.v.pair] || pal[n++ % pal.length]; });
    return out;
  }

  // ---- Formatting ------------------------------------------------------------------------
  const trimN = (v, d) => String(Number(v.toFixed(d)));
  function axisNum(v) {
    const a = Math.abs(v);
    if (a >= 1e6) return trimN(v / 1e6, 2) + 'M';
    if (a >= 1e4) return trimN(v / 1e3, 1) + 'k';
    if (a >= 100) return trimN(v, 0);
    if (a >= 1) return trimN(v, 2);
    return trimN(v, 3);
  }
  const unitTxt = u => u === 'ratio' ? '' : ' ' + u;
  const valTxt = (v, u) => v == null ? '–' : fmt(v, (UNITS[u] || { d: 1 }).d) + unitTxt(u);
  const dayFmt = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
  const dfmt = v => { const d = new Date(typeof v === 'string' && !/^\d+$/.test(v) ? v : +v); return Number.isNaN(d.getTime()) ? '' : dayFmt.format(d); };
  const timeFmt = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

  // ---- ECharts option -----------------------------------------------------------------------
  const inst = new Map();     // chart id -> echarts instance
  const live = new Map();     // chart id -> {series, axes, nameToId}

  function buildOption(c, keepX) {
    const S = c.settings, dateX = c.x === 'date';
    const col = { label: cssVar('--label'), sec: cssVar('--secondary'), sep: cssVar('--separator'),
                  card: cssVar('--card'), tint: cssVar('--tint'), fill: cssVar('--fill') };
    const series = seriesOf(c);
    const visible = series.filter(s => !c.hidden[s.id]);
    const axisKey = s => S.splitAxes ? (s.v.pair || s.vk) : s.unit;   // a well test shares its model series' axis
    const axes = [];
    visible.forEach(s => {
      let a = axes.find(x => x.key === axisKey(s));
      if (!a) axes.push(a = { key: axisKey(s), unit: s.unit, series: [] });
      a.series.push(s);
    });
    axes.forEach((a, i) => { a.side = i % 2 ? 'right' : 'left'; a.off = Math.floor(i / 2); });
    const nL = axes.filter(a => a.side === 'left').length, nR = axes.length - nL;
    const multi = axes.length > 1;
    const font = FONTS[S.fontFamily] ? FONTS[S.fontFamily][1] : FONTS.system[1];
    const fs = +S.fontSize;
    const axisIdx = axes.map((_, i) => i);
    const xRange = keepX && c.zoomed && c.xWin ? { startValue: c.xWin[0], endValue: c.xWin[1] } : { start: 0, end: 100 };

    const yAxis = axes.map((a, i) => {
      const color = multi ? a.series[0].color : col.sec;
      const name = S.splitAxes ? `${V[a.key].label}${a.unit === 'ratio' ? '' : ', ' + a.unit}` : (a.unit === 'ratio' ? 'WOR' : a.unit);
      return {
        type: S.logY ? 'log' : 'value', position: a.side, offset: a.off * AXW, name,
        nameTextStyle: { color, fontSize: fs - 1, fontWeight: 500, align: a.side === 'left' ? 'right' : 'left',
                         padding: a.side === 'left' ? [0, 6, 0, 0] : [0, 0, 0, 6] }, nameGap: 12,
        scale: !(UNITS[a.unit] || {}).zero, alignTicks: false, splitNumber: 5,
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: multi ? color : col.sec, fontSize: fs - 1, formatter: axisNum, hideOverlap: true, margin: 10 },
        splitLine: { show: S.grid && i === 0, lineStyle: { color: col.sep, opacity: .7 } },
      };
    });
    if (!yAxis.length) yAxis.push({ type: 'value', show: false });

    const xVar = dateX ? null : V[c.x];
    const xAxis = dateX ? {
      type: 'time',
      axisLabel: { color: col.sec, fontSize: fs - 1, hideOverlap: true, margin: 10,
        formatter: { year: '{yyyy}', month: '{MMM}', day: '{d} {MMM}', hour: '{HH}:{mm}', minute: '{HH}:{mm}' } },
      axisLine: { lineStyle: { color: col.sep } }, axisTick: { show: false }, splitLine: { show: false },
      axisPointer: { label: { formatter: p => dfmt(p.value) } },
    } : {
      type: 'value', name: `${xVar.label}${unitTxt(xVar.unit)}`, nameLocation: 'middle', nameGap: fs + 16,
      nameTextStyle: { color: col.sec, fontSize: fs - 1, fontWeight: 500 }, scale: !(UNITS[xVar.unit] || {}).zero,
      axisLabel: { color: col.sec, fontSize: fs - 1, formatter: axisNum, hideOverlap: true, margin: 10 },
      axisLine: { lineStyle: { color: col.sep } }, axisTick: { show: false },
      splitLine: { show: S.grid, lineStyle: { color: col.sep, opacity: .45 } },
    };

    const cumX = !dateX && xVar.group === 'cum';
    const eSeries = series.map(s => {
      const ai = Math.max(0, axes.findIndex(a => a.key === axisKey(s)));
      const base = { id: s.id, name: s.name, yAxisIndex: ai, data: s.data, itemStyle: { color: s.color }, color: s.color };
      if (s.test) return { ...base, type: 'scatter', symbol: 'circle', symbolSize: +S.testSize, z: 5,
        itemStyle: { color: s.color, borderColor: col.card, borderWidth: 1.5 },
        emphasis: { scale: 1.4, itemStyle: { borderWidth: 2 } } };
      if (!dateX && !cumX) return { ...base, type: 'scatter', symbolSize: 5, itemStyle: { color: s.color, opacity: .75 } };
      return { ...base, type: 'line', showSymbol: !!S.markers, symbol: 'circle', symbolSize: 4, smooth: S.smooth ? .3 : false,
        connectNulls: false, lineStyle: { width: +S.lineWidth, type: S.lineStyle, color: s.color, cap: 'round', join: 'round' },
        emphasis: { disabled: true } };
    });

    // Range bars: quiet tracks with small white pill handles, so the data stays the focus
    const PILL = 'path://M-4,-10h8a4,4 0 0 1 4,4v12a4,4 0 0 1 -4,4h-8a4,4 0 0 1 -4,-4v-12a4,4 0 0 1 4,-4z';
    const zoomStyle = {
      borderColor: 'transparent', backgroundColor: hexA(toHex(col.sec), .06), fillerColor: hexA(col.tint, .07),
      handleIcon: PILL, handleSize: '100%',
      handleStyle: { color: col.card, borderColor: col.sep, borderWidth: 1, shadowBlur: 3, shadowColor: 'rgba(0,0,0,.18)', shadowOffsetY: 1 },
      moveHandleSize: 0, showDataShadow: false,
      emphasis: { handleStyle: { borderColor: col.tint, borderWidth: 1.5 } },
      textStyle: { color: col.sec, fontSize: fs - 1 }, brushSelect: false,
    };
    const dataZoom = [
      { type: 'slider', id: 'xs', xAxisIndex: 0, filterMode: 'weakFilter', bottom: S.margin.b, height: ZX, ...zoomStyle, ...xRange,
        showDataShadow: true, dataBackground: { lineStyle: { color: col.sec, opacity: .35, width: .8 }, areaStyle: { color: col.sec, opacity: .06 } },
        selectedDataBackground: { lineStyle: { color: col.tint, opacity: .6, width: .8 }, areaStyle: { color: col.tint, opacity: .08 } },
        labelFormatter: dateX ? v => dfmt(v) : v => axisNum(v) },
      { type: 'inside', id: 'xi', xAxisIndex: 0, filterMode: 'weakFilter', zoomOnMouseWheel: 'ctrl', moveOnMouseMove: true, moveOnMouseWheel: false, ...xRange },
    ];
    if (axes.length) dataZoom.push(
      { type: 'slider', id: 'ys', yAxisIndex: axisIdx, orient: 'vertical', filterMode: 'none', right: S.margin.r, ...zoomStyle,
        width: ZY, height: null, top: S.margin.t, bottom: S.margin.b + ZX + 30 + (dateX ? 0 : fs + 10), showDetail: false },
      { type: 'inside', id: 'yi', yAxisIndex: axisIdx, filterMode: 'none', zoomOnMouseWheel: 'shift', moveOnMouseMove: 'shift', moveOnMouseWheel: false },
    );

    const tipBox = { backgroundColor: col.card, borderColor: col.sep, borderWidth: 1, padding: [8, 10],
      textStyle: { color: col.label, fontSize: fs, fontFamily: font }, extraCssText: 'box-shadow:0 6px 24px rgba(0,0,0,.14);border-radius:10px;' };
    const tooltip = dateX ? { trigger: 'axis', confine: true, ...tipBox, axisPointer: { type: 'line', lineStyle: { color: col.sec, type: 'dashed' } },
      formatter: ps => {
        const t = ps.length ? ps[0].axisValue : null;
        const rows = ps.filter(p => p.value && p.value[1] != null && Math.abs(p.value[0] - t) <= .6 * DAYMS);
        if (!rows.length) return '';
        const lv = live.get(c.id);
        return `<div style="font-weight:600;margin-bottom:4px">${dfmt(t)}</div>` + rows.map(p => {
          const s = lv && lv.byId[p.seriesId];
          const when = s && s.test ? ` <span style="opacity:.6">test ${(Number.isFinite(+p.value[0]) ? timeFmt.format(p.value[0]) : '')}</span>` : '';
          return `<div style="display:flex;gap:14px;justify-content:space-between"><span>${p.marker}${esc(p.seriesName)}${when}</span><b>${valTxt(p.value[1], s ? s.unit : '')}</b></div>`;
        }).join('') + '<div style="opacity:.55;margin-top:4px;font-size:.9em">Click a point for all values that day</div>';
      } } : { trigger: 'item', confine: true, ...tipBox, formatter: p => {
        const lv = live.get(c.id), s = lv && lv.byId[p.seriesId];
        return `<div style="font-weight:600;margin-bottom:4px">${p.marker}${esc(p.seriesName)}</div>
          <div>${dfmt(p.value[2])}${s && s.test ? ' (well test)' : ''}</div>
          <div>${esc(xVar.label)}: <b>${valTxt(p.value[0], xVar.unit)}</b></div>
          <div>${esc(s ? s.v.label : '')}: <b>${valTxt(p.value[1], s ? s.unit : '')}</b></div>`;
      } };

    const selected = Object.fromEntries(series.map(s => [s.name, !c.hidden[s.id]]));
    const empty = !series.length;
    return {
      option: {
        animation: true, animationDuration: 300, animationDurationUpdate: 250,
        backgroundColor: 'transparent',
        textStyle: { fontFamily: font, fontSize: fs, color: col.label },
        grid: { left: S.margin.l + Math.max(nL, 1) * AXW, right: S.margin.r + ZY + 14 + Math.max(nR, 0) * AXW + (nR ? 0 : 10),
                top: S.margin.t, bottom: S.margin.b + ZX + 30 + (dateX ? 0 : fs + 10), containLabel: false },
        // Legend: a short bar for daily lines, a dot for measured well tests
        legend: { type: 'scroll', top: 4, left: S.margin.l + Math.max(nL, 1) * AXW - 4, right: S.margin.r + ZY + 14,
                  data: series.map(s => ({ name: s.name, icon: s.test || (!dateX && !cumX) ? 'circle' : LINE_ICON })),
                  selected, itemGap: 20, itemWidth: 14, itemHeight: 8,
                  textStyle: { color: col.label, fontSize: fs, fontFamily: font, padding: [0, 0, 0, 2] }, inactiveColor: hexA(toHex(col.sec), .35),
                  pageIconColor: col.tint, pageIconSize: 10, pageTextStyle: { color: col.sec } },
        tooltip, xAxis, yAxis, dataZoom, series: eSeries,
        // Hidden toolbox: only there so the Box zoom button can switch on ECharts' rectangle zoom
        toolbox: { show: true, right: 0, top: 0, itemSize: 1, showTitle: false, iconStyle: { opacity: 0 }, emphasis: { iconStyle: { opacity: 0 } },
                   feature: { dataZoom: { xAxisIndex: 0, yAxisIndex: axisIdx.length ? axisIdx : false, filterMode: 'weakFilter' } } },
        graphic: empty ? [{ type: 'text', left: 'center', top: 'middle', style: { text: 'Pick at least one well or group and one variable above.', fill: col.sec, fontSize: 14, fontFamily: font } }] : [],
      },
      series, axes,
    };
  }

  const LINE_ICON = 'path://M1,0H13A1,1 0 0 1 13,2.5H1A1,1 0 0 1 1,0Z';
  function hexA(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // ---- Drawing --------------------------------------------------------------------------
  function draw(c, { keepX = true } = {}) {
    const el = document.querySelector(`[data-chart="${c.id}"] .p-chart`);
    if (!el || typeof echarts === 'undefined') return;
    el.style.height = (+c.settings.height) + 'px';
    el.closest('[data-chart]').style.setProperty('--ph', (+c.settings.height + 52) + 'px');
    let ch = inst.get(c.id);
    if (!ch || ch.isDisposed() || ch.getDom() !== el) {
      if (ch && !ch.isDisposed()) ch.dispose();
      ch = echarts.init(el, null, { renderer: 'canvas' });
      inst.set(c.id, ch);
      wire(c, ch, el);
    }
    const { option, series, axes } = buildOption(c, keepX);
    live.set(c.id, { series, axes, byId: Object.fromEntries(series.map(s => [s.id, s])), nameToId: Object.fromEntries(series.map(s => [s.name, s.id])) });
    ch.setOption(option, { notMerge: true });
    ch.resize();
    if (c.boxZoom) setBoxZoom(c, true);
    refreshColors(c);
    updateSummary(c);
  }

  function wire(c, ch, el) {
    ch.on('legendselectchanged', p => {
      const lv = live.get(c.id);
      Object.entries(p.selected).forEach(([name, on]) => {
        const id = lv.nameToId[name];
        if (id) { if (on) delete c.hidden[id]; else c.hidden[id] = true; }
      });
      save();
      draw(c);                      // re-fit the value axes to what is still shown
    });
    ch.on('datazoom', () => {
      const z = (ch.getOption().dataZoom || []).find(d => d.id === 'xs');
      const full = z && z.start <= 0.01 && z.end >= 99.99;
      const r = xExtent(ch);
      c.zoomed = !full && !!r; c.xWin = c.zoomed ? r : null;
    });
    ch.on('click', p => showDetail(c, p));
    const ro = new ResizeObserver(() => { if (!ch.isDisposed()) ch.resize(); });
    ro.observe(el);
  }

  function xExtent(ch) {
    try { return ch.getModel().getComponent('xAxis', 0).axis.scale.getExtent().slice(); } catch (e) { return null; }
  }
  function yExtents(ch, n) {
    try { return Array.from({ length: n }, (_, i) => ch.getModel().getComponent('yAxis', i).axis.scale.getExtent().slice()); } catch (e) { return []; }
  }
  function fullX(c) {
    const lv = live.get(c.id);
    const xs = lv.series.filter(s => !c.hidden[s.id]).flatMap(s => s.data.map(p => p[0])).filter(v => v != null);
    return xs.length ? [Math.min(...xs), Math.max(...xs)] : null;
  }

  // ---- Tools --------------------------------------------------------------------------------
  function zoomBy(c, f) {
    const ch = inst.get(c.id), cur = xExtent(ch), full = fullX(c);
    if (!cur || !full) return;
    const mid = (cur[0] + cur[1]) / 2, half = (cur[1] - cur[0]) / 2 * f;
    let a = mid - half, b = mid + half;
    if (b - a >= full[1] - full[0]) { a = full[0]; b = full[1]; }
    else if (a < full[0]) { b += full[0] - a; a = full[0]; } else if (b > full[1]) { a -= b - full[1]; b = full[1]; }
    ch.dispatchAction({ type: 'dataZoom', dataZoomId: 'xs', startValue: a, endValue: b });
    c.xWin = [a, b]; c.zoomed = true;
  }
  function setBoxZoom(c, on) {
    const ch = inst.get(c.id);
    c.boxZoom = on;
    ch.dispatchAction({ type: 'takeGlobalCursor', key: 'dataZoomSelect', dataZoomSelectActive: on });
    const b = document.querySelector(`[data-chart="${c.id}"] [data-tool="box"]`);
    if (b) b.setAttribute('aria-pressed', on);
  }
  function home(c) { c.zoomed = false; c.xWin = null; draw(c, { keepX: false }); }
  function autoscale(c) { draw(c, { keepX: true }); }

  function chartImage(c) {
    const ch = inst.get(c.id), S = c.settings;
    const url = ch.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: cssVar('--card'), excludeComponents: ['toolbox', 'dataZoom'] });
    return new Promise(res => {
      const img = new Image();
      img.onload = () => {
        const pad = 2 * (S.fontSize * 1.6 + 22);
        const cv = document.createElement('canvas');
        cv.width = img.width; cv.height = img.height + pad;
        const g = cv.getContext('2d');
        g.fillStyle = cssVar('--card'); g.fillRect(0, 0, cv.width, cv.height);
        g.fillStyle = cssVar('--label');
        g.font = `600 ${2 * (+S.fontSize + 5)}px ${FONTS[S.fontFamily] ? FONTS[S.fontFamily][1] : FONTS.system[1]}`;
        g.textBaseline = 'middle';
        g.fillText(titleOf(c), 2 * (S.margin.l + 8), pad / 2 + 4);
        g.drawImage(img, 0, pad);
        cv.toBlob(res, 'image/png');
      };
      img.src = url;
    });
  }
  const fileName = (c, ext) => (titleOf(c).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'chart') + '.' + ext;
  function saveBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // Table of the shown series inside the current x range
  function table(c) {
    const ch = inst.get(c.id), lv = live.get(c.id), dateX = c.x === 'date';
    const shown = lv.series.filter(s => !c.hidden[s.id]);
    const win = c.zoomed ? xExtent(ch) : null;
    const inWin = x => !win || (x >= win[0] && x <= win[1]);
    const head = s => `${s.name}${s.unit === 'ratio' ? '' : ' (' + s.unit + ')'}`;
    const num = (v, u) => v == null ? '' : Number(v.toFixed(Math.max((UNITS[u] || { d: 1 }).d, 1) + 2));
    if (dateX) {
      const rows = new Map();
      shown.forEach((s, j) => s.data.forEach(p => {
        if (p[1] == null || !inWin(p[0])) return;
        const label = s.test ? `${localDate(p[0])} ${timeFmt.format(p[0])}` : localDate(p[0]);   // tests keep their time
        if (!rows.has(label)) rows.set(label, { t: p[0], v: [] });
        rows.get(label).v[j] = num(p[1], s.unit);
      }));
      const body = [...rows.entries()].sort((a, b) => a[1].t - b[1].t)
        .map(([k, r]) => [k, ...shown.map((_, j) => r.v[j] ?? '')]);
      return [['Date', ...shown.map(head)], ...body];
    }
    const xv = V[c.x];
    const body = shown.flatMap(s => s.data.filter(p => inWin(p[0])).map(p => [s.name, localDate(p[2]), num(p[0], xv.unit), num(p[1], s.unit), s.unit === 'ratio' ? '' : s.unit]));
    return [['Series', 'Date', `${xv.label}${xv.unit === 'ratio' ? '' : ' (' + xv.unit + ')'}`, 'Value', 'Unit'], ...body];
  }
  const pad2 = n => String(n).padStart(2, '0');
  const localDate = t => { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
  const csvCell = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    }
  }

  function toast(c, msg, bad) {
    const t = document.querySelector(`[data-chart="${c.id}"] .p-toast`);
    if (!t) return;
    t.textContent = msg; t.classList.toggle('bad', !!bad); t.hidden = false;
    clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, 2600);
  }

  async function tool(c, name, btn) {
    const ch = inst.get(c.id);
    if (!ch) return;
    if (c.playing && name !== 'play') stopPlay(c);
    switch (name) {
      case 'zin': return zoomBy(c, .5);
      case 'zout': return zoomBy(c, 2);
      case 'box': return setBoxZoom(c, !c.boxZoom);
      case 'home': return home(c);
      case 'auto': return autoscale(c);
      case 'play': return c.playing ? stopPlay(c) : play(c);
      case 'png': {
        const blob = await chartImage(c);
        saveBlob(blob, fileName(c, 'png')); return toast(c, 'Image downloaded');
      }
      case 'img': {
        try {
          const blob = await chartImage(c);
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          return toast(c, 'Image copied. Paste it into a document or chat.');
        } catch (e) { return toast(c, 'This browser blocked copying images. Use Download PNG instead.', true); }
      }
      case 'copy': {
        const t = table(c);
        const ok = await copyText(t.map(r => r.join('\t')).join('\n'));
        return toast(c, ok ? `Copied ${t.length - 1} rows${c.zoomed ? ' in the current view' : ''}. Paste into Excel.` : 'Copying was blocked by the browser.', !ok);
      }
      case 'csv': {
        const t = table(c);
        saveBlob(new Blob([t.map(r => r.map(csvCell).join(',')).join('\n')], { type: 'text/csv' }), fileName(c, 'csv'));
        return toast(c, `Downloaded ${t.length - 1} rows${c.zoomed ? ' in the current view' : ''}`);
      }
      case 'dup': {
        const i = charts.indexOf(c);
        const d = { ...clone({ ...c, playing: false, _q: '' }), id: newId(), title: (titleOf(c) + ' (copy)'), zoomed: false, xWin: null, boxZoom: false };
        charts.splice(i + 1, 0, d); save();
        const card = document.querySelector(`[data-chart="${c.id}"]`);
        card.insertAdjacentHTML('afterend', cardHtml(d));
        draw(d, { keepX: false });
        document.querySelector(`[data-chart="${d.id}"]`).scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      case 'full': {
        const card = document.querySelector(`[data-chart="${c.id}"]`);
        if (document.fullscreenElement) return document.exitFullscreen();
        if (card.requestFullscreen) return card.requestFullscreen().catch(() => toast(c, 'Full screen is not available here.', true));
        return toast(c, 'Full screen is not available here.', true);
      }
      case 'settings': {
        const p = document.querySelector(`[data-chart="${c.id}"] .p-settings`);
        p.hidden = !p.hidden;
        btn.setAttribute('aria-pressed', !p.hidden);
        if (!p.hidden) p.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
      }
    }
  }

  // ---- Time-lapse: reveal the data from the first day to the last --------------------------
  function play(c) {
    draw(c, { keepX: false }); c.zoomed = false;
    const ch = inst.get(c.id), lv = live.get(c.id);
    const shown = lv.series.filter(s => !c.hidden[s.id]);
    if (!shown.length) return;
    const tOf = p => c.x === 'date' ? p[0] : p[2];
    const ts = shown.flatMap(s => s.data.map(tOf));
    const t0 = Math.min(...ts), t1 = Math.max(...ts);
    const xe = xExtent(ch), ye = yExtents(ch, lv.axes.length);
    ch.setOption({ animation: false, xAxis: { min: xe[0], max: xe[1] }, yAxis: ye.map(e => ({ min: e[0], max: e[1] })) });
    c.playing = true; setPlayBtn(c, true);
    const dur = Math.min(12000, Math.max(5000, (t1 - t0) / DAYMS * 30));
    const start = performance.now();
    const step = now => {
      if (!c.playing || ch.isDisposed()) return;
      const f = Math.min(1, (now - start) / dur), cut = t0 + (t1 - t0) * f;
      ch.setOption({
        series: shown.map(s => ({ id: s.id, data: s.data.filter(p => tOf(p) <= cut) })),
        graphic: [{ type: 'text', right: c.settings.margin.r + ZY + 30, top: c.settings.margin.t + 6,
          style: { text: dfmt(cut), fill: cssVar('--secondary'), fontSize: +c.settings.fontSize + 4, fontWeight: 600 } }],
      });
      if (f < 1) c.raf = requestAnimationFrame(step);
      else { c.playing = false; setPlayBtn(c, false); setTimeout(() => draw(c, { keepX: false }), 600); }
    };
    c.raf = requestAnimationFrame(step);
  }
  function stopPlay(c) {
    c.playing = false; cancelAnimationFrame(c.raf); setPlayBtn(c, false); draw(c, { keepX: false });
  }
  function setPlayBtn(c, on) {
    const b = document.querySelector(`[data-chart="${c.id}"] [data-tool="play"]`);
    if (!b) return;
    b.innerHTML = on ? ICON.pause : ICON.play;
    b.setAttribute('aria-label', on ? 'Stop time-lapse' : 'Play time-lapse');
    b.dataset.tip = on ? 'Stop' : 'Play time-lapse';
    b.setAttribute('aria-pressed', on);
  }

  // ---- Point details --------------------------------------------------------------------
  function showDetail(c, p) {
    const lv = live.get(c.id), s = lv && lv.byId[p.seriesId];
    if (!s || !p.value) return;
    const m = model();
    const t = c.x === 'date' ? p.value[0] : p.value[2];
    const day = localDate(t), i = m.idx.get(day);
    const groups = GROUPS.filter(([g]) => g !== 'test').map(([g, label]) => {
      const rows = VARS.filter(v => v.group === g && available(v.k)).map(v => {
        const val = i == null ? null : daily(s.e, v.k)[i];
        return val == null ? '' : `<div class="p-kv"><span>${esc(v.label)}</span><b>${valTxt(val, v.unit)}</b></div>`;
      }).join('');
      return rows ? `<div class="p-dgroup"><h4>${label}</h4>${rows}</div>` : '';
    }).join('');
    const tRecs = isWell(s.e) ? ((D.tests || {})[s.e] || []).filter(r => r.t.slice(0, 10) === day) : [];
    const testHtml = tRecs.map(r => `<div class="p-dgroup"><h4>Well test at ${esc(r.t.slice(11))}</h4>${
      VARS.filter(v => v.tkey && r[v.tkey] != null).map(v => `<div class="p-kv"><span>${esc(v.label.replace('Test ', ''))}</span><b>${valTxt(r[v.tkey], v.unit)}</b></div>`).join('')}</div>`).join('');
    const box = document.querySelector(`[data-chart="${c.id}"] .p-detail`);
    box.innerHTML = `<div class="p-dhead"><h3>${esc(entLabel(s.e))}, ${dfmt(t)}</h3>
        <span class="p-dpick">You clicked ${esc(s.name)}: <b>${valTxt(p.value[1], s.unit)}</b></span>
        <button type="button" class="p-x" data-act="close-detail" aria-label="Close details">${ICON.close}</button></div>
      <div class="p-dgrid">${testHtml}${groups || '<p class="footnote">No daily values on this day.</p>'}</div>`;
    box.hidden = false;
  }

  // ---- Markup ----------------------------------------------------------------------------
  const svg = d => `<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICON = {
    zin: svg('<circle cx="8.5" cy="8.5" r="5.5"/><path d="M8.5 6v5M6 8.5h5M13 13l4.5 4.5"/>'),
    zout: svg('<circle cx="8.5" cy="8.5" r="5.5"/><path d="M6 8.5h5M13 13l4.5 4.5"/>'),
    box: svg('<rect x="3" y="4" width="14" height="11" rx="1" stroke-dasharray="2.5 2"/><path d="M12 11l5 5"/>'),
    home: svg('<path d="M3 9.5 10 3.5l7 6M5 8v8.5h4v-5h2v5h4V8"/>'),
    auto: svg('<path d="M10 2.5v15M6.5 6 10 2.5 13.5 6M6.5 14 10 17.5 13.5 14M3 10h3M14 10h3"/>'),
    play: svg('<path d="M6 4l10 6-10 6z" fill="currentColor"/>'),
    pause: svg('<rect x="5" y="4" width="3.5" height="12" rx="1" fill="currentColor"/><rect x="11.5" y="4" width="3.5" height="12" rx="1" fill="currentColor"/>'),
    img: svg('<rect x="2.5" y="5" width="15" height="11" rx="2"/><circle cx="10" cy="10.5" r="3"/><path d="M7 5l1.2-2h3.6L13 5"/>'),
    png: svg('<path d="M10 3v10M6 9l4 4 4-4M3.5 16.5h13"/>'),
    copy: svg('<rect x="6" y="3" width="11" height="13" rx="2"/><path d="M3.5 6.5v10a1.5 1.5 0 0 0 1.5 1.5h8"/><path d="M9 7.5h5M9 10.5h5M9 13.5h3"/>'),
    csv: svg('<path d="M4 2.5h8l4 4v11H4z"/><path d="M12 2.5v4h4M7 11h6M7 14h6M10 8.5v8"/>'),
    dup: svg('<rect x="6.5" y="6.5" width="10.5" height="10.5" rx="2"/><path d="M13.5 6.5V4.5A1.5 1.5 0 0 0 12 3H4.5A1.5 1.5 0 0 0 3 4.5V12a1.5 1.5 0 0 0 1.5 1.5h2"/>'),
    full: svg('<path d="M3 7.5V3h4.5M12.5 3H17v4.5M17 12.5V17h-4.5M7.5 17H3v-4.5"/>'),
    settings: svg('<circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4"/>'),
    close: svg('<path d="M5 5l10 10M15 5 5 15"/>'),
    side: svg('<rect x="2.5" y="3.5" width="15" height="13" rx="2"/><path d="M7.5 3.5v13M4.5 7h1M4.5 9.5h1M4.5 12h1"/>'),
    plus: svg('<path d="M10 4v12M4 10h12"/>'),
    trash: svg('<path d="M4 6h12M8 6V4h4v2M6 6l.8 10.5h6.4L14 6"/>'),
  };
  const TOOLS = [
    [['zin', 'Zoom in'], ['zout', 'Zoom out'], ['box', 'Box zoom: drag a rectangle', true], ['home', 'Home: show everything'], ['auto', 'Auto-scale the value axes']],
    [['play', 'Play time-lapse', true]],
    [['img', 'Copy image'], ['png', 'Download PNG'], ['copy', 'Copy data (paste into Excel)'], ['csv', 'Download CSV']],
    [['dup', 'Duplicate chart'], ['full', 'Full screen'], ['settings', 'Chart settings', true]],
  ];

  // Side panel: x axis, wells under their manifold, and variables in collapsible categories
  const GROUP_NOTE = { cum: 'Since 1 Jan 2025 unless stated', sensor: 'Daily averages while the well is flowing',
                       test: 'Measured values; wells only, not groups' };
  function catOpen(c, g) {
    if (c._q) return true;
    if (c.openGroups && g in c.openGroups) return c.openGroups[g];
    return c.vars.some(k => V[k] && V[k].group === g);
  }
  function sideHtml(c) {
    const m = model(), wells = wellIds();
    const box = (attr, val, on, label, extra = '') => `<label class="p-opt"${extra}><input type="checkbox" ${attr}="${esc(val)}"${on ? ' checked' : ''}>
      <span class="p-box" aria-hidden="true"></span><span class="p-optl">${label}</span></label>`;
    const opts = GROUPS.filter(([g]) => g !== 'test').map(([g, label]) =>
      `<optgroup label="${esc(label)}">${VARS.filter(v => v.group === g && available(v.k)).map(v =>
        `<option value="${v.k}" ${c.x === v.k ? 'selected' : ''}>${esc(v.label)}${unitTxt(v.unit) ? ' (' + v.unit + ')' : ''}</option>`).join('')}</optgroup>`).join('');
    const byMan = m.manifolds.map(g => [g, wells.filter(w => (m.info[w] || {}).manifold === g)]);
    const loose = wells.filter(w => !byMan.some(([, ws]) => ws.includes(w)));
    const wellGrid = ws => `<div class="p-wgrid">${ws.map(w => box('data-pe', w, c.entities.includes(w), esc(w))).join('')}</div>`;
    const sigma = '<span class="p-sigma" aria-hidden="true">Σ</span>';
    const total = (id, label, tip) => box('data-pe', id, c.entities.includes(id), sigma + label, ` title="${esc(tip)}"`);
    const ents = `
      ${total('F', 'Field total', 'All wells: rates summed, ratios from the sums, sensors averaged')}
      ${byMan.map(([g, ws]) => `<div class="p-man">
          <div class="p-manh"><span>Manifold ${esc(g)}</span><button type="button" class="p-link" data-pman="${esc(g)}">Select wells</button></div>
          ${total('M:' + g, `Manifold ${esc(g)} total`, `Wells ${ws.join(', ')}: rates summed, ratios from the sums, sensors averaged`)}
          ${wellGrid(ws)}</div>`).join('')}
      ${loose.length ? `<div class="p-man">${byMan.length ? '<div class="p-manh"><span>Other wells</span></div>' : ''}${wellGrid(loose)}</div>` : ''}`;
    const cats = GROUPS.map(([g, label]) => {
      const vs = VARS.filter(v => v.group === g && available(v.k));
      if (!vs.length) return '';
      const n = vs.filter(v => c.vars.includes(v.k)).length;
      return `<details class="p-vcat" data-g="${g}"${catOpen(c, g) ? ' open' : ''}>
        <summary><span class="p-chev" aria-hidden="true"></span><span class="p-catl">${esc(label)}</span><span class="p-count" data-count="${g}">${n || ''}</span></summary>
        ${GROUP_NOTE[g] ? `<p class="p-catnote">${GROUP_NOTE[g]}</p>` : ''}
        <div class="p-vitems">${vs.map(v => `<label class="p-opt p-var" data-find="${esc((v.label + ' ' + (v.desc || '') + ' ' + label).toLowerCase())}"
            title="${esc((v.desc ? v.desc + '. ' : '') + (v.unit === 'ratio' ? 'Ratio' : v.unit))}"><input type="checkbox" data-pv="${v.k}"${c.vars.includes(v.k) ? ' checked' : ''}>
            <span class="p-box" aria-hidden="true"></span><span class="p-optl">${esc(v.label)}</span><span class="p-unit">${v.unit === 'ratio' ? '' : esc(v.unit)}</span></label>`).join('')}</div>
      </details>`;
    }).join('');
    return `
      <div class="p-sec">
        <label class="p-sech" for="px-${c.id}">X axis</label>
        <select id="px-${c.id}" class="p-select" data-px><option value="date" ${c.x === 'date' ? 'selected' : ''}>Date</option>${opts}</select>
      </div>
      <div class="p-sec">
        <div class="p-sech"><span>Wells and groups</span><span class="p-acts">
          <button type="button" class="p-link" data-pall="wells">All</button><button type="button" class="p-link" data-pall="none">Clear</button></span></div>
        ${ents}
      </div>
      <div class="p-sec p-secv">
        <div class="p-sech"><span>Variables</span><span class="p-acts"><button type="button" class="p-link" data-pvclear>Clear</button></span></div>
        <input type="search" class="p-search" data-psearch placeholder="Search variables" aria-label="Search variables" value="${esc(c._q || '')}">
        <div class="p-cats">${cats}</div>
        <p class="p-empty" hidden>No variable matches.</p>
      </div>
      <p class="p-note">Daily values are model estimates; well tests are measured.${available('rf') ? ' RF uses a rough volumetric oil in place, so some wells exceed 100%.' : ''}</p>`;
  }

  // Bring the panel in line with the chart's config without rebuilding it (keeps scroll and focus)
  function syncSide(c) {
    const card = document.querySelector(`[data-chart="${c.id}"]`);
    if (!card) return;
    card.querySelectorAll('[data-pe]').forEach(i => { i.checked = c.entities.includes(i.dataset.pe); });
    card.querySelectorAll('[data-pv]').forEach(i => { i.checked = c.vars.includes(i.dataset.pv); });
    GROUPS.forEach(([g]) => {
      const el = card.querySelector(`[data-count="${g}"]`);
      if (el) el.textContent = c.vars.filter(k => V[k] && V[k].group === g).length || '';
    });
    const onlyGroups = c.entities.length > 0 && c.entities.every(e => !isWell(e));
    card.querySelectorAll('.p-vcat[data-g="test"]').forEach(d => d.classList.toggle('p-off', onlyGroups));
    const t = card.querySelector('[data-title]');
    if (t && !c.title) t.value = autoTitle(c);
  }

  function filterVars(c, q) {
    const card = document.querySelector(`[data-chart="${c.id}"]`);
    c._q = q.trim().toLowerCase();
    let any = false;
    card.querySelectorAll('.p-vcat').forEach(d => {
      let hits = 0;
      d.querySelectorAll('.p-var').forEach(l => { const ok = !c._q || l.dataset.find.includes(c._q); l.hidden = !ok; hits += ok; });
      d.hidden = !hits;
      d.open = catOpen(c, d.dataset.g);
      any = any || hits > 0;
    });
    card.querySelector('.p-empty').hidden = any;
  }

  function settingsHtml(c) {
    const S = c.settings;
    const num = (k, label, min, max, step = 1, val = S[k]) => `<label class="p-field"><span>${label}</span>
      <input type="number" data-set="${k}" min="${min}" max="${max}" step="${step}" value="${val}"></label>`;
    const sel = (k, label, opts) => `<label class="p-field"><span>${label}</span><select data-set="${k}">${opts.map(([v, t]) =>
      `<option value="${v}" ${String(S[k]) === String(v) ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`;
    const tog = (k, label) => `<label class="p-check"><input type="checkbox" data-set="${k}" ${S[k] ? 'checked' : ''}><span>${label}</span></label>`;
    const mar = (k, label) => `<label class="p-field"><span>${label}</span><input type="number" data-margin="${k}" min="0" max="200" value="${S.margin[k]}"></label>`;
    return `<div class="p-shead"><h3>Chart settings</h3>
        <button type="button" class="p-link" data-act="reset-settings">Reset to defaults</button></div>
      <div class="p-sgrid">
        <fieldset><legend>Text</legend>
          <label class="p-field wide"><span>Title</span><input type="text" data-set="title" value="${esc(titleOf(c))}"></label>
          ${sel('fontFamily', 'Font', Object.entries(FONTS).map(([k, v]) => [k, v[0]]))}
          ${num('fontSize', 'Font size', 9, 24)}
        </fieldset>
        <fieldset><legend>Lines and points</legend>
          ${num('lineWidth', 'Line width', .5, 6, .5)}
          ${sel('lineStyle', 'Line style', [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']])}
          ${num('testSize', 'Well-test marker size', 4, 20)}
          ${tog('markers', 'Show a marker on every day')}
          ${tog('smooth', 'Smooth lines')}
        </fieldset>
        <fieldset><legend>Axes and layout</legend>
          ${num('height', 'Chart height, px', 260, 1400, 20)}
          ${tog('grid', 'Gridlines')}
          ${tog('splitAxes', 'One value axis per variable')}
          ${tog('logY', 'Logarithmic value axes')}
        </fieldset>
        <fieldset><legend>Margins, px</legend>
          <div class="p-margins">${mar('t', 'Top')}${mar('r', 'Right')}${mar('b', 'Bottom')}${mar('l', 'Left')}</div>
        </fieldset>
        <fieldset class="p-colors"><legend>Series colours</legend><div data-colors></div></fieldset>
      </div>`;
  }

  function refreshColors(c) {
    const box = document.querySelector(`[data-chart="${c.id}"] [data-colors]`);
    const lv = live.get(c.id);
    if (!box || !lv) return;
    box.innerHTML = lv.series.length ? lv.series.map(s => `<label class="p-color"><input type="color" data-color="${esc(s.id)}" value="${toHex(s.color)}">
      <span>${esc(s.name)}</span>${c.settings.colors[s.id] ? `<button type="button" class="p-link" data-act="reset-color" data-id="${esc(s.id)}">Reset</button>` : ''}</label>`).join('')
      : '<p class="footnote">Pick some data first.</p>';
  }
  function toHex(c) {
    if (/^#[0-9a-f]{6}$/i.test(c)) return c;
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(c);
    return m ? '#' + [m[1], m[2], m[3]].map(x => (+x).toString(16).padStart(2, '0')).join('') : '#007aff';
  }

  function updateSummary(c) {
    const el = document.querySelector(`[data-chart="${c.id}"] [data-sum]`);
    const lv = live.get(c.id);
    if (!el || !lv) return;
    const n = lv.series.length, h = lv.series.filter(s => c.hidden[s.id]).length;
    el.textContent = n ? `${n} series${h ? `, ${h} hidden` : ''}${c.x === 'date' ? '' : ` · against ${V[c.x].label}`}` : 'No data picked';
  }

  function cardHtml(c) {
    const tools = TOOLS.map(g => `<div class="p-tgroup">${g.map(([k, label, toggle]) =>
      `<button type="button" class="p-tool" data-tool="${k}" data-tip="${esc(label)}" aria-label="${esc(label)}"${toggle ? ` aria-pressed="${k === 'box' ? !!c.boxZoom : false}"` : ''}>${ICON[k]}</button>`).join('')}</div>`).join('');
    const open = c.pickOpen !== false;
    return `<section class="card pcard" data-chart="${c.id}" aria-label="${esc(titleOf(c))}" style="--ph:${+c.settings.height + 52}px">
      <div class="p-head">
        <button type="button" class="p-x p-sidebtn" data-act="side" aria-pressed="${open}" aria-label="Show or hide the data panel" data-tip="Data panel">${ICON.side}</button>
        <input class="p-title" data-title value="${esc(titleOf(c))}" aria-label="Chart title, click to edit" spellcheck="false">
        <span class="p-sum" data-sum></span>
        <button type="button" class="p-x" data-act="remove" aria-label="Remove this chart" data-tip="Remove chart">${ICON.trash}</button>
      </div>
      <div class="p-body${open ? '' : ' noside'}">
        <aside class="p-side" aria-label="Data to plot">${sideHtml(c)}</aside>
        <div class="p-main">
          <div class="p-chart" role="img" aria-label="${esc(titleOf(c))}" style="height:${+c.settings.height}px"></div>
          <div class="p-tools" role="toolbar" aria-label="Chart tools">${tools}<span class="p-toast" role="status" hidden></span></div>
          <p class="p-hint">Drag to pan. Ctrl + scroll zooms the dates, Shift + scroll the values. Click a legend item to hide it, or a point for that day's values.</p>
        </div>
      </div>
      <div class="p-detail" hidden></div>
      <div class="p-settings" hidden>${settingsHtml(c)}</div>
    </section>`;
  }

  // ---- Events (one delegated listener per page) ----------------------------------------------
  const chartOf = el => { const card = el.closest('[data-chart]'); return card && charts.find(c => c.id === card.dataset.chart); };
  function onClick(e) {
    const el = e.target.closest('button');
    if (!el) return;
    const c = chartOf(el);
    if (el.matches('[data-act="add"]')) {
      const n = defaultChart(); charts.push(n); save();
      document.getElementById('p-charts').insertAdjacentHTML('beforeend', cardHtml(n));
      draw(n, { keepX: false });
      document.querySelector(`[data-chart="${n.id}"]`).scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (!c) return;
    if (el.dataset.tool) return tool(c, el.dataset.tool, el);
    if (el.dataset.pman) {
      const ws = members('M:' + el.dataset.pman);
      c.entities = [...new Set([...c.entities, ...ws])];
    } else if ('pvclear' in el.dataset) {
      c.vars = [];
    } else if (el.dataset.act === 'side') {
      c.pickOpen = !(c.pickOpen !== false); save();
      el.setAttribute('aria-pressed', c.pickOpen);
      el.closest('[data-chart]').querySelector('.p-body').classList.toggle('noside', !c.pickOpen);
      return;
    } else if (el.dataset.pall) {
      const ws = wellIds();
      c.entities = el.dataset.pall === 'wells' ? [...new Set([...c.entities.filter(x => !isWell(x)), ...ws])] : c.entities.filter(x => !isWell(x));
    } else if (el.dataset.act === 'remove') {
      inst.get(c.id)?.dispose(); inst.delete(c.id);
      charts = charts.filter(x => x !== c); save();
      el.closest('[data-chart]').remove();
      return;
    } else if (el.dataset.act === 'close-detail') {
      el.closest('.p-detail').hidden = true; return;
    } else if (el.dataset.act === 'reset-settings') {
      c.settings = clone(DEFAULTS); save();          // the title is kept
      el.closest('.p-settings').innerHTML = settingsHtml(c);
      return draw(c);
    } else if (el.dataset.act === 'reset-color') {
      delete c.settings.colors[el.dataset.id]; save(); return draw(c);
    } else return;
    save(); syncSide(c); draw(c);
  }
  function onInput(e) {
    const el = e.target, c = chartOf(el);
    if (!c) return;
    if (el.matches('[data-title]')) {
      c.title = el.value; save();
      const st = el.closest('[data-chart]').querySelector('[data-set="title"]');
      if (st) st.value = el.value;
      return;
    }
    if (el.matches('[data-set="title"]')) {
      c.title = el.value; save();
      document.querySelector(`[data-chart="${c.id}"] [data-title]`).value = el.value;
      return;
    }
    if (el.matches('[data-psearch]')) return filterVars(c, el.value);
    if ((el.dataset.pe || el.dataset.pv) && e.type === 'change') {
      const set = (list, id) => el.checked ? [...new Set([...list, id])] : list.filter(x => x !== id);
      if (el.dataset.pe) c.entities = set(c.entities, el.dataset.pe);
      else c.vars = set(c.vars, el.dataset.pv);
      save(); syncSide(c); return draw(c);
    }
    if (el.dataset.pe || el.dataset.pv) return;
    if (el.matches('[data-color]')) {
      c.settings.colors[el.dataset.color] = el.value; save();
      clearTimeout(c._ct); c._ct = setTimeout(() => draw(c), 60);
      return;
    }
    if (e.type === 'input' && (el.type === 'number')) { clearTimeout(c._nt); c._nt = setTimeout(() => applySetting(c, el), 250); return; }
    if (e.type === 'change') applySetting(c, el);
  }
  function applySetting(c, el) {
    if (el.matches('[data-px]')) {
      c.x = el.value; c.zoomed = false; c.xWin = null; save(); syncSide(c); return draw(c, { keepX: false });
    }
    if (el.dataset.margin) {
      const v = Number(el.value); if (Number.isFinite(v)) c.settings.margin[el.dataset.margin] = Math.max(0, Math.min(200, v));
    } else if (el.dataset.set) {
      const k = el.dataset.set;
      if (k === 'title') return;
      if (el.type === 'checkbox') c.settings[k] = el.checked;
      else if (el.type === 'number') { const v = Number(el.value); if (!Number.isFinite(v)) return; c.settings[k] = Math.max(+el.min, Math.min(+el.max, v)); }
      else c.settings[k] = el.value;
    } else return;
    save(); draw(c);
  }

  // ---- Page ------------------------------------------------------------------------------
  function dispose() {
    charts && charts.forEach(c => { if (c.playing) { c.playing = false; cancelAnimationFrame(c.raf); } });
    inst.forEach(ch => { if (!ch.isDisposed()) ch.dispose(); });
    inst.clear(); live.clear();
  }

  function render(view) {
    dispose();
    load();
    const ws = new Set(wellIds()), m = model();
    const okEnt = e => ws.has(e) || e === 'F' || (e.startsWith('M:') && m.manifolds.includes(e.slice(2)));
    charts.forEach(c => { c.entities = c.entities.filter(okEnt); c.vars = c.vars.filter(k => V[k]); c.zoomed = false; c.xWin = null; c.boxZoom = false; });
    if (typeof echarts === 'undefined') {
      view.innerHTML = `<header class="page-head"><h1 class="large-title">Plot</h1></header>
        <section class="card note">${infoIcon}<p><b>The chart library did not load.</b> Check that <code>web/echarts.min.js</code> is present.</p></section>`;
      return;
    }
    const noSensors = !VARS.filter(v => v.group === 'sensor').some(v => available(v.k));
    view.innerHTML = `
      <header class="page-head">
        <h1 class="large-title">Plot</h1>
        <p class="subtitle">Build your own charts from any rate, ratio, sensor or well-test series. Pick wells or groups and the
          variables to show, then zoom, compare and export.</p>
      </header>
      ${noSensors ? `<section class="card note">${infoIcon}<p>Sensor averages are not in this data set. Rerun the upload to add them.</p></section>` : ''}
      <div id="p-charts">${charts.map(cardHtml).join('')}</div>
      <button type="button" class="btn p-add" data-act="add">${ICON.plus}<span>Add chart</span></button>`;
    view.onclick = onClick;
    view.oninput = onInput;
    view.onchange = onInput;
    view.removeEventListener('toggle', onToggle, true);
    view.addEventListener('toggle', onToggle, true);    // 'toggle' does not bubble, so listen while capturing
    charts.forEach(c => { draw(c, { keepX: false }); syncSide(c); if (c._q) filterVars(c, c._q); });
  }

  // Clear the handlers this page put on the shared view element when another page is shown
  function leave(view) {
    dispose();
    view.onclick = view.oninput = view.onchange = null;
    view.removeEventListener('toggle', onToggle, true);
  }
  function onToggle(e) {
    const c = chartOf(e.target);
    if (c && e.target.matches('.p-vcat') && !c._q) {
      c.openGroups = { ...(c.openGroups || {}), [e.target.dataset.g]: e.target.open }; save();
    }
  }

  document.addEventListener('fullscreenchange', () => {
    inst.forEach(ch => { if (!ch.isDisposed()) setTimeout(() => ch.resize(), 60); });
  });

  return { render, leave };
})();
