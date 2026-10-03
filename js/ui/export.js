/* Export Compare results: CSV per table / all tables, and a full PowerPoint deck (PptxGenJS, lazy-loaded). */
(function () {
  const TC = window.TC;
  const f = TC.fmt;
  const v = TC.v;

  // ------------------------------------------------------------------ shared row model
  const CAT = {
    onprem: 'Buy servers (on-prem)',
    cloud_reserved: 'Rent GPUs — reserved',
    cloud_ondemand: 'Rent GPUs — on-demand',
    api_same: 'Pay per token — same model',
    api_closed: 'Pay per token — closed models',
  };
  function catOf(r) {
    if (r.category === 'api') return r.sameModel ? 'api_same' : 'api_closed';
    return r.category;
  }
  function config(r) {
    if (!r.feasible) return '';
    if (r.category === 'onprem') {
      const b = r.sizing.best;
      return `${r.cost.nodes} node(s), ${r.cost.gpus} GPUs, ${b.replicas} replica(s) × TP${b.tp}${b.pp > 1 ? '×PP' + b.pp : ''}`;
    }
    if (r.category === 'api') return `${f.price(v(r.price.input_per_m))} in / ${f.price(v(r.price.output_per_m))} out per 1M`;
    return `${r.pricing}, ${r.cost.gpus} GPUs`;
  }
  function basis(r) {
    if (r.basis === 'benchmark') return 'Measured benchmark';
    if (r.basis === 'theoretical') return 'Theoretical estimate';
    if (r.basis === 'price list') return 'Price list';
    return '';
  }
  function uniqPlaceholders(r) { return new Set((r.placeholders || []).map(p => p.label)).size; }

  function sortRows(rows) {
    const view = TC.resultsView || { sort: 'name' };
    return rows.slice().sort((a, b) => {
      if (a.feasible !== b.feasible) return a.feasible ? -1 : 1;
      if (view.sort === 'cost' && a.feasible && b.feasible) return a.perM - b.perM;
      return (a.name + ' ' + a.sub).localeCompare(b.name + ' ' + b.sub);
    });
  }

  function allRows(res) {
    return sortRows(res.onprem).concat(sortRows(res.cloud), sortRows(res.api.filter(r => r.sameModel)), sortRows(res.api.filter(r => !r.sameModel)));
  }

  // ------------------------------------------------------------------ CSV
  const HEAD = ['Category', 'Option', 'Detail', 'Configuration', 'Throughput basis', 'Avg utilization %', 'Monthly (USD)', 'Per year (USD)', 'Total over term (USD)', 'USD per 1M tokens', 'Placeholder values used', 'Warnings', 'Fits'];
  function csvRow(r) {
    return [
      CAT[catOf(r)], r.name, r.sub, config(r), basis(r),
      r.feasible && r.util != null ? Math.round(r.util * 1000) / 10 : '',
      r.feasible ? Math.round(r.monthly * 100) / 100 : '',
      r.feasible ? Math.round(r.monthly * 1200) / 100 : '',
      r.feasible ? Math.round(r.total * 100) / 100 : '',
      r.feasible ? Math.round(r.perM * 10000) / 10000 : '',
      uniqPlaceholders(r),
      (r.flags || []).join(' | ') || (r.feasible ? '' : r.reason || ''),
      r.feasible ? 'yes' : 'no',
    ];
  }
  function cell(x) {
    const s = String(x == null ? '' : x);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(lines) { return '﻿' + lines.map(l => l.map(cell).join(',')).join('\r\n') + '\r\n'; }
  function saveText(name, text, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }
  function workloadLines(w, wl, data) {
    const model = data.models.models.find(m => m.id === w.model_id);
    return [
      ['Workload profile', ''],
      ['Model', model ? model.name : w.model_id],
      ['Weight / KV precision', `${w.precision} / ${w.kv_precision}`],
      ['Users', w.users], ['Requests per user per day', w.requests_per_user_per_day],
      ['Avg input tokens', w.avg_input_tokens], ['Avg output tokens', w.avg_output_tokens],
      ['Active days per month', w.active_days_per_month],
      ['Peak concurrent requests', w.peak_concurrent_requests + (w.peak_concurrency_mode === 'derived' ? ` (derived: ${w.busy_hour_share_pct}% busy-hour share, ${w.burst_percentile}th-percentile burst)` : ' (manual)')],
      ['Target output tok/s per request', w.target_output_tps_per_request], ['Max context', w.max_context],
      ['Headroom %', w.headroom_pct], ['N+1 spare server', w.n_plus_one ? 'yes' : 'no'], ['Term (years)', w.term_years],
      ['Tokens per month', Math.round(wl.tMo)], ['Tokens over term', Math.round(wl.tTerm)],
      ['Filters', TC.filtersActive && TC.filtersActive() ? TC.filterSummary() : 'none (all options)'],
      ['Exported', new Date().toLocaleString()], ['Note', 'Estimates, not quotes. See the app for sources and placeholder values.'],
      [],
    ];
  }

  TC.exportCsv = function (which) {
    saveText(`token-calculator-${which || 'all'}-${TC.today()}.csv`, TC.buildCsv(which), 'text/csv;charset=utf-8');
  };
  TC.buildCsv = function (which) {
    const { w, data } = TC.lastResults;
    const res = TC.applyFilters ? TC.applyFilters(TC.lastResults.res) : TC.lastResults.res;
    let rows = allRows(res);
    if (which && which !== 'all') rows = rows.filter(r => catOf(r) === which || (which === 'cloud' && r.category.startsWith('cloud')));
    const lines = !which || which === 'all' ? workloadLines(w, res.wl, data) : [];
    lines.push(HEAD, ...rows.map(csvRow));
    return toCsv(lines);
  };

  // ------------------------------------------------------------------ one option, with specs and every calculation step
  const plain = v => (v && typeof v === 'object' && 'value' in v) ? v.value : v;
  const SPEC = { sku: 'Model / SKU', gpus_per_node: 'GPUs per node', price_mode: 'Price mode', price_usd: 'Price (USD)', base_price_usd: 'Base price (USD)', power_kw: 'Power (kW)', rack_units: 'Rack units',
    memory_gb: 'Memory (GB)', mem_bandwidth_tbps: 'Memory bandwidth (TB/s)', dense_tflops_fp16: 'Dense TFLOPS (FP16)', dense_tflops_fp8: 'Dense TFLOPS (FP8)', dense_tflops_fp4: 'Dense TFLOPS (FP4)', street_price_usd: 'Street price (USD)',
    input_per_m: 'Input (USD per 1M tokens)', output_per_m: 'Output (USD per 1M tokens)', cached_input_per_m: 'Cached input (USD per 1M tokens)', batch_discount_pct: 'Batch discount %' };
  function specLines(title, obj, skip) {
    if (!obj) return [];
    const out = [[title, '']];
    Object.keys(obj).forEach(k => {
      if (skip.includes(k) || k.startsWith('_')) return;
      const v = plain(obj[k]);
      if (v == null || typeof v === 'object') return;
      out.push([SPEC[k] || (k.charAt(0).toUpperCase() + k.slice(1)).replace(/_/g, ' '), v]);
    });
    return out.concat([[]]);
  }
  function stepLines(title, steps) {
    if (!steps || !steps.length) return [];
    return [[title], ['Step', 'Formula', 'Value', 'Unit', 'Note']]
      .concat(steps.map(st => [st.label, st.formula, typeof st.value === 'number' && isFinite(st.value) ? Math.round(st.value * 10000) / 10000 : st.value, st.unit || '', st.note || '']), [[]]);
  }
  /** One option as workbook sheets: Summary, Specs, Workload, Sizing, Cost, Sources (sheets with nothing to show are left out). */
  TC.buildRowSheets = function (id) {
    const { w, data, res } = TC.lastResults;
    const r = allRows(res).find(x => x.id === id);
    if (!r) return null;
    const row = csvRow(r);
    const summary = [['Option export', `${CAT[catOf(r)]}: ${r.name} · ${r.sub}`], []]
      .concat(HEAD.map((h, k) => [h, row[k]]), [[]], workloadLines(w, res.wl, data));
    const specs = [].concat(specLines('Server specifications', r.server, ['id', 'gpu_id', 'feed']), specLines('GPU specifications', r.gpu, ['id', 'cloud', 'feed']),
      r.price ? specLines('API price', r.price, ['feed']) : []);
    let sizing = [];
    if (r.sizing && r.sizing.best) {
      const b = r.sizing.best;
      sizing = sizing.concat(stepLines('Model memory', r.sizing.shared.steps), stepLines(`Chosen layout (TP ${b.tp}${b.pp > 1 ? ' × PP ' + b.pp : ''})`, b.steps));
      if (r.sizing.candidates && r.sizing.candidates.length > 1) {
        sizing.push(['Layouts evaluated'], ['Layout', 'GPUs per replica', 'Max concurrent per replica', 'Basis', 'Aggregate tok/s', 'Replicas', 'Nodes', 'Result']);
        r.sizing.candidates.forEach(c => sizing.push([`TP ${c.tp}${c.pp > 1 ? ' × PP ' + c.pp : ''}`, c.gpusPerReplica, c.feasible ? Math.round(c.Crep) : '', c.feasible ? c.basis : '', c.feasible ? Math.round(c.aggTps) : '', c.feasible ? c.replicas : '', c.feasible ? c.nodes : '', c === r.sizing.best ? 'chosen' : (c.reason || '')]));
      }
    }
    const sources = [];
    const prov = [].concat(r.sizing ? r.sizing.prov.items : [], r.cost ? r.cost.prov.items : []);
    if (prov.length) {
      const seen = new Set();
      sources.push(['Value', 'Amount', 'Status', 'Source', 'As of']);
      prov.forEach(i => { if (seen.has(i.label)) return; seen.add(i.label); sources.push([i.label, i.value, i.status || '', i.source || '', i.as_of || '']); });
    }
    const sheets = [
      { name: 'Summary', rows: summary, cols: [34, 70] },
      { name: 'Specs', rows: specs, cols: [34, 30] },
      { name: 'Workload', rows: stepLines('Workload calculation', res.wl.steps), cols: [34, 60, 18, 12, 60] },
      { name: 'Sizing', rows: sizing, cols: [34, 60, 18, 12, 60, 10, 8, 40] },
      { name: 'Cost', rows: r.cost ? stepLines('Cost calculation', r.cost.steps) : [], cols: [34, 60, 18, 12, 60] },
      { name: 'Sources', rows: sources, cols: [40, 16, 12, 90, 12] },
    ].filter(sh => sh.rows.some(l => l && l.length));
    return { name: `${r.name} ${r.sub}`, sheets };
  };
  let xlsxPromise = null;
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve();
    if (!xlsxPromise) xlsxPromise = new Promise((resolve, reject) => {
      const sc = document.createElement('script');
      sc.src = TC.config.xlsxLib;
      sc.onload = () => resolve();
      sc.onerror = () => { xlsxPromise = null; reject(new Error('Could not load the Excel library. Check your internet connection.')); };
      document.head.appendChild(sc);
    });
    return xlsxPromise;
  }
  /** Builds the workbook; returns a Blob, or downloads it unless { save: false }. */
  TC.exportRowXlsx = async function (id, opts) {
    const x = TC.buildRowSheets(id);
    if (!x) return null;
    await loadXlsx();
    const wb = XLSX.utils.book_new();
    x.sheets.forEach(sh => {
      const ws = XLSX.utils.aoa_to_sheet(sh.rows);
      ws['!cols'] = sh.cols.map(wch => ({ wch }));
      XLSX.utils.book_append_sheet(wb, ws, sh.name);
    });
    wb.Props = { Title: 'AI Inference Economics Calculator: ' + x.name, Company: 'Pellera Technologies' };
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    if (opts && opts.save === false) return blob;
    const slug = x.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `token-calculator-${slug}-${TC.today()}.xlsx`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    return blob;
  };

  // ------------------------------------------------------------------ PowerPoint
  let libPromise = null;
  function loadLib() {
    if (window.PptxGenJS) return Promise.resolve();
    if (libPromise) return libPromise;
    libPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = TC.config.pptxLib;
      s.onload = () => resolve();
      s.onerror = () => { libPromise = null; reject(new Error('Could not load the PowerPoint library (' + TC.config.pptxLib + '). Check your internet connection.')); };
      document.head.appendChild(s);
    });
    return libPromise;
  }
  async function logoData() {
    try {
      const res = await fetch('assets/pellera-logo.png');
      const blob = await res.blob();
      return await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
    } catch (e) { return null; }
  }

  const P = { purple: '7A17FF', ink: '1A1A1A', ink2: '4A4A4A', muted: '7A7873', line: 'E1E0D9', tint: 'F4ECFF', warn: 'FFF1D6', white: 'FFFFFF' };
  const SERIES = ['2A78D6', 'EB6834', '1BAF7A', 'EDA100', 'E87BA4'];
  const FONT = 'Segoe UI';

  /** Builds the deck and downloads it. Pass { save: false } to get a Blob instead (used by checks). */
  TC.exportPptx = async function (onStatus, opts) {
    const save = !opts || opts.save !== false;
    const status = onStatus || (() => {});
    status('Loading PowerPoint library…');
    await loadLib();
    const logo = await logoData();
    const { w, data } = TC.lastResults;
    const res = TC.applyFilters ? TC.applyFilters(TC.lastResults.res) : TC.lastResults.res;
    const wl = res.wl;
    const model = data.models.models.find(m => m.id === w.model_id);
    const C = TC.config;
    status('Building slides…');

    const pptx = new window.PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
    pptx.author = C.authors;
    pptx.company = C.org;
    pptx.title = `AI workload cost comparison — ${model ? model.name : ''}`;
    const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    pptx.defineSlideMaster({
      title: 'CONTENT',
      background: { color: P.white },
      objects: [
        { rect: { x: 0, y: 0, w: 13.333, h: 0.08, fill: { color: P.purple } } },
        { line: { x: 0.5, y: 7.0, w: 12.333, h: 0, line: { color: P.line, width: 0.75 } } },
        { text: { text: `${C.org} · ${C.appName} · Internal · Estimates, not quotes · ${dateStr}`, options: { x: 0.5, y: 7.05, w: 10, h: 0.3, fontFace: FONT, fontSize: 9, color: P.muted } } },
      ].concat(logo ? [{ image: { data: logo, x: 12.1, y: 0.3, w: 0.72, h: 0.47 } }] : []),
      slideNumber: { x: 12.4, y: 7.05, w: 0.5, h: 0.3, fontFace: FONT, fontSize: 9, color: P.muted, align: 'right' },
    });

    const titled = (title, sub) => {
      const s = pptx.addSlide({ masterName: 'CONTENT' });
      s.addText(title, { x: 0.5, y: 0.3, w: 11.3, h: 0.6, fontFace: FONT, fontSize: 26, bold: true, color: P.ink });
      if (sub) s.addText(sub, { x: 0.5, y: 0.9, w: 11.3, h: 0.4, fontFace: FONT, fontSize: 13, color: P.ink2 });
      return s;
    };
    const hdr = cells => cells.map(t => ({ text: t, options: { bold: true, color: P.white, fill: { color: P.purple }, fontSize: 11 } }));
    const tableOpts = (colW, y) => ({ x: 0.5, y: y || 1.45, w: 12.333, colW, fontFace: FONT, fontSize: 10.5, color: P.ink, border: { type: 'solid', pt: 0.5, color: P.line }, valign: 'middle', margin: 0.05, rowH: 0.38 });
    const note = (s, text, y) => s.addText(text, { x: 0.5, y: y || 6.45, w: 12.333, h: 0.45, fontFace: FONT, fontSize: 10, color: P.ink2, italic: true });

    // 1. Title
    const t = pptx.addSlide();
    t.background = { color: P.white };
    t.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.35, h: 7.5, fill: { color: P.purple } });
    if (logo) t.addImage({ data: logo, x: 1.0, y: 0.9, w: 1.6, h: 1.04 });
    // Title sits above the subtitle and grows upward; long scenario names (up to 80 characters) get a smaller size.
    const coverTitle = w.scenario_name || 'AI inference economics';
    const coverSize = coverTitle.length > 60 ? 26 : coverTitle.length > 44 ? 30 : coverTitle.length > 30 ? 34 : 40;
    t.addText(coverTitle, { x: 1.0, y: 1.75, w: 11, h: 1.4, fontFace: FONT, fontSize: coverSize, bold: true, color: P.ink, valign: 'bottom', fit: 'shrink' });
    t.addText(w.scenario_name ? 'AI inference economics — on-prem vs GPU cloud vs API' : 'Self-hosted on-prem vs GPU cloud vs public API', { x: 1.0, y: 3.2, w: 11, h: 0.5, fontFace: FONT, fontSize: 20, color: P.purple });
    t.addText(`${model ? model.name : w.model_id} · ${w.precision} weights · ${f.tokens(wl.tMo)} tokens/month · ${w.term_years}-year view`, { x: 1.0, y: 3.85, w: 11, h: 0.4, fontFace: FONT, fontSize: 15, color: P.ink2 });
    t.addText(dateStr, { x: 1.0, y: 4.3, w: 11, h: 0.4, fontFace: FONT, fontSize: 13, color: P.muted });
    t.addText([
      { text: `Prepared with the ${C.org} ${C.appName}`, options: { breakLine: true } },
      { text: C.copyright },
    ], { x: 1.0, y: 6.2, w: 11, h: 0.7, fontFace: FONT, fontSize: 11, color: P.muted });

    // 2. Workload profile
    const s2 = titled('Workload profile', TC.filtersActive && TC.filtersActive() ? 'Options in this deck are filtered — ' + TC.filterSummary() : 'The shared inputs every option below is sized and priced against');
    const L = [
      ['Users', f.int(w.users)], ['Requests per user per day', f.num(w.requests_per_user_per_day)],
      ['Avg input / output tokens', `${f.int(w.avg_input_tokens)} / ${f.int(w.avg_output_tokens)}`],
      ['Active days per month', f.num(w.active_days_per_month)],
      ['Peak concurrent requests', f.int(w.peak_concurrent_requests) + (w.peak_concurrency_mode === 'derived' ? ` (derived, ${f.num(w.busy_hour_share_pct)}% busy hour)` : '')],
      ['Target output speed', `${f.num(w.target_output_tps_per_request)} tok/s per request`], ['Max context', f.int(w.max_context) + ' tokens'],
    ];
    const R = [
      ['Model', model ? model.name : w.model_id], ['Weight / KV-cache precision', `${w.precision} / ${w.kv_precision}`],
      ['Headroom', `${f.num(w.headroom_pct)}%${w.n_plus_one ? ' + one spare server (N+1)' : ''}`], ['Term', `${w.term_years} years`],
      ['Tokens per month', `${f.tokens(wl.tMo)} (${f.tokens(wl.tInMo)} in · ${f.tokens(wl.tOutMo)} out)`],
      ['Tokens over term', f.tokens(wl.tTerm)],
      ['Required output throughput', `${f.int(w.peak_concurrent_requests * w.target_output_tps_per_request)} tok/s at peak`],
    ];
    const kv = rows => rows.map(([a, b]) => [{ text: a, options: { color: P.ink2 } }, { text: String(b), options: { bold: true } }]);
    s2.addTable(kv(L), { x: 0.5, y: 1.5, w: 6.0, colW: [3.0, 3.0], fontFace: FONT, fontSize: 12, border: { type: 'solid', pt: 0.5, color: P.line }, rowH: 0.5, margin: 0.08 });
    s2.addTable(kv(R), { x: 6.83, y: 1.5, w: 6.0, colW: [2.7, 3.3], fontFace: FONT, fontSize: 12, border: { type: 'solid', pt: 0.5, color: P.line }, rowH: 0.5, margin: 0.08 });

    // Executive summary + confidence (same logic as the Compare tab's summary card; always unfiltered)
    const X = TC.execSummary(data, w, TC.lastResults.res);
    const se = titled('Executive summary', `Lowest-cost option in each category over ${w.term_years} years, per year${w.scenario_name ? ' · ' + w.scenario_name : ''}`);
    const toneFill = { good: 'E3F4EA', mid: 'FFF1D6', cool: 'E6ECFB', neutral: 'EEEEEE' }[X.verdict.tone];
    const toneInk = { good: '16603A', mid: '7A4B00', cool: '1F3F8F', neutral: '444444' }[X.verdict.tone];
    se.addShape(pptx.ShapeType.roundRect, { x: 0.5, y: 1.45, w: 4.2, h: 0.55, rectRadius: 0.27, fill: { color: toneFill }, line: { color: toneFill } });
    se.addText(X.verdict.label, { x: 0.5, y: 1.45, w: 4.2, h: 0.55, fontFace: FONT, fontSize: 16, bold: true, color: toneInk, align: 'center', valign: 'middle' });
    const HY = X.hybrid;
    const hyRow = HY ? { monthly: HY.best.total, name: HY.best.row ? HY.best.setup + ' + ' + HY.api.name : HY.api.name + ' only', sub: `${TC.fmtShare(HY.best.share)} of tokens owned`, perM: HY.best.total * 12 * w.term_years / (res.wl.tTerm / 1e6) } : null;
    const onTile = X.on ? Object.assign({}, X.on, { name: X.onLabel, sub: `${f.num(X.on.util * 100, X.on.util < 0.01 ? 1 : 0)}% utilized` }) : null;
    // Same rules as the app: the verdict's box is marked Recommended; the hybrid box shows a price only for a real mix.
    const winIdx = { onprem: 0, 'onprem-likely': 0, cloud: 1, api: 2, near: 2, hybrid: 3 }[X.verdict.key];
    let hyText = null;
    if (HY) {
      const b = HY.best, allOwned = b.row && (b.pct >= 100 || b.apiMonthly * 12 < 1);
      if (HY.rightSized && !HY.wins) hyText = ['Not needed', `${HY.rightSized.setup} alone carries ${TC.fmtShare(HY.rightSized.share)} of tokens (right-sized on-prem)`];
      else if (!b.row || allOwned) hyText = ['Not needed', !b.row ? 'Best mix is all API: same as paying per token' : 'Best mix is all owned: same as buying servers'];
      else if (!HY.material) hyText = ['Not worth it', `API would take only ${TC.fmtShare(1 - b.share)} of tokens (${f.usdCompact(b.apiMonthly * 12)}/yr): too little to justify a hybrid`];
    }
    const tiles = [['Buy servers (on-prem)', onTile, X.onRange], ['Rent GPUs (GPU cloud)', X.cl, X.clRange], ['Pay per token (same model)', X.api, null], ['Hybrid (owned + API)', hyRow, null, hyText]];
    tiles.forEach(([lbl, r, rng, alt], i) => {
      const x0 = 0.5 + i * 3.1, win = i === winIdx;
      se.addShape(pptx.ShapeType.roundRect, { x: x0, y: 2.25, w: 2.95, h: 2.4, rectRadius: 0.15, fill: { color: win ? P.white : 'F4ECFF' }, line: { color: win ? P.purple : 'F4ECFF', width: win ? 2 : 0.75 } });
      if (alt) {
        se.addText([
          { text: lbl, options: { fontSize: 13, color: P.ink2, breakLine: true } },
          { text: alt[0], options: { fontSize: 17, bold: true, color: P.muted, breakLine: true } },
          { text: alt[1], options: { fontSize: 11, color: P.ink2 } },
        ], { x: x0 + 0.15, y: 2.35, w: 2.7, h: 2.2, fontFace: FONT, valign: 'top', fit: 'shrink' });
        return;
      }
      se.addText([
        { text: lbl + (win ? ' · Recommended' : ''), options: { fontSize: win ? 12 : 13, color: win ? P.purple : P.ink2, bold: win, breakLine: true } },
        { text: r ? f.usdCompact(r.monthly * 12) : '—', options: { fontSize: 19, bold: true, color: P.purple, breakLine: true } },
        { text: r ? 'per year' + (TC.rangeNote(rng) ? ' · ' + TC.rangeNote(rng).replace(' with optimistic or pessimistic inputs', '') : '') : '', options: { fontSize: 11, color: P.muted, breakLine: true } },
        { text: r ? `${r.name} · ${r.sub}` : 'No option fits', options: { fontSize: 11, color: P.ink2, breakLine: true } },
        { text: r ? `${f.perM(r.perM)} per 1M tokens` : '', options: { fontSize: 11, color: P.muted } },
      ], { x: x0 + 0.15, y: 2.35, w: 2.7, h: 2.2, fontFace: FONT, valign: 'top', fit: 'shrink' });
    });
    const beText = X.multiple === 0 ? `Owning servers is already cheaper than ${X.altLabel} at today's volume.`
      : isFinite(X.multiple) ? `Owning servers becomes cheaper than ${X.altLabel} at about ${f.tokens(X.breakevenTokens)} tokens/month — ${f.num(X.multiple, X.multiple < 10 ? 1 : 0)}× today's usage.`
      : `${X.altLabel.charAt(0).toUpperCase() + X.altLabel.slice(1)} stays cheaper than owning servers up to 2,000× today's usage.`;
    se.addText([
      { text: 'Breakeven: ', options: { bold: true, color: P.ink } }, { text: beText, options: { color: P.ink, breakLine: true, paraSpaceAfter: 10 } },
      { text: 'Why: ', options: { bold: true, color: P.ink } }, { text: X.why, options: { color: P.ink2, breakLine: true, paraSpaceAfter: 10 } },
      { text: `Confidence: ${X.level}. `, options: { bold: true, color: P.ink } }, { text: 'Ranges reflect uncertain throughput and placeholder prices — see the next slide.', options: { color: P.ink2 } },
    ], { x: 0.5, y: 4.85, w: 12.3, h: 1.95, fontFace: FONT, fontSize: 14, valign: 'top' });

    if (HY) {
      const sh = titled('Hybrid: own some servers, send the rest to an API', 'Yearly cost of each option: your servers plus API for the traffic they don\u2019t handle (' + HY.api.name + ')');
      const OPTS = TC.hybridOptions(HY).slice().reverse(); // bar charts draw the first category at the bottom
      const optLabel = p => TC.shortSetup(p) + (p.row ? (p.capPct >= 100 ? ' (full peak)' : ` (${p.capPct}% of peak)`) : '');
      sh.addChart(pptx.ChartType.bar, [
        { name: 'Your servers', labels: OPTS.map(optLabel), values: OPTS.map(p => Math.round(p.ownedMonthly * 12)) },
        { name: 'API (' + HY.api.name + ')', labels: OPTS.map(optLabel), values: OPTS.map(p => Math.round(p.apiMonthly * 12)) },
      ], {
        x: 0.5, y: 1.45, w: 8.3, h: 4.9, barDir: 'bar', barGrouping: 'stacked', chartColors: [P.purple, 'C9C3D9'],
        valAxisLabelFormatCode: '$#,##0', valAxisLabelFontSize: 9, catAxisLabelFontSize: 9, valAxisTitle: 'Cost per year', showValAxisTitle: true, valAxisTitleFontSize: 10,
        valGridLine: { color: P.line, size: 0.5 }, catGridLine: { style: 'none' }, showLegend: true, legendPos: 'b', legendFontSize: 10, legendFontFace: FONT,
      });
      const b = HY.best;
      const msg = HY.wins
        ? `Lowest cost: own ${b.row ? b.setup : ''}, which covers ${TC.capText(b)}, and send the rest to ${HY.api.name}. ${TC.fmtShare(b.share)} of tokens run on owned GPUs.`
        : !b.row ? 'At this volume the lowest-cost mix is all API.' : b.pct >= 100 ? 'At this volume the lowest-cost mix is all owned.' : `A ${b.pct}% baseline is cheapest, but saves under 5% versus the best single option.`;
      sh.addText([
        { text: msg, options: { breakLine: true, paraSpaceAfter: 12, color: P.ink } },
        { text: `Hybrid: ${f.usdCompact(b.total * 12)}/yr`, options: { bold: true, color: P.purple, breakLine: true } },
        { text: `All API: ${f.usdCompact(HY.apiOnly * 12)}/yr`, options: { color: P.ink2, breakLine: true } },
        { text: `All owned: ${f.usdCompact(HY.onPremOnly * 12)}/yr`, options: { color: P.ink2, breakLine: true, paraSpaceAfter: 12 } },
        { text: 'Assumes requests can be routed to either owned GPUs or the API (e.g. via a gateway) and the same model runs on both.', options: { color: P.muted, fontSize: 10 } },
      ], { x: 9.1, y: 1.5, w: 3.73, h: 4.9, fontFace: FONT, fontSize: 13, valign: 'top' });
    }

    const sc = titled(`Confidence: ${X.level}`, 'What is measured or current, and what is still an estimate');
    sc.addTable([hdr(['', 'Input', 'Status'])].concat(X.checks.map(c => [
      { text: c.ok ? '✓' : '⚠', options: { align: 'center', bold: true, color: c.ok ? '16603A' : '7A4B00', fill: { color: c.ok ? 'E3F4EA' : P.warn } } },
      { text: c.label, options: { bold: true } }, c.detail,
    ])), Object.assign(tableOpts([0.6, 3.6, 8.133]), { rowH: 0.5, fontSize: 13 }));
    note(sc, 'Ranges on the summary come from optimistic and pessimistic cases for throughput efficiency, placeholder server prices and power load. Firm up the ⚠ items (measured benchmarks, current server pricing) to narrow them.', 5.9);

    // 3. Summary: cheapest per category
    const cats = ['onprem', 'cloud_reserved', 'cloud_ondemand', 'api_same', 'api_closed'];
    const rowsAll = allRows(res);
    const bestBy = {};
    cats.forEach(c => {
      rowsAll.filter(r => catOf(r) === c && r.feasible).forEach(r => { if (!bestBy[c] || r.perM < bestBy[c].perM) bestBy[c] = r; });
    });
    const present = cats.filter(c => bestBy[c]);
    const s3 = titled('Summary: lowest-cost option in each category', 'Under the current assumptions. Every option is listed on the following slides.');
    s3.addTable([hdr(['Category', 'Lowest-cost option', 'Monthly', 'Per year', `Total (${w.term_years} yr)`, '$ / 1M tokens'])].concat(present.map(c => {
      const r = bestBy[c];
      return [CAT[c], `${r.name} — ${r.sub}`, f.usd(r.monthly), f.usd(r.monthly * 12), f.usd(r.total), { text: f.perM(r.perM), options: { bold: true } }];
    })), tableOpts([2.4, 4.6, 1.3, 1.3, 1.43, 1.3]));
    if (present.length) {
      s3.addChart(pptx.ChartType.bar, [{ name: '$ per 1M tokens', labels: present.map(c => CAT[c]), values: present.map(c => Math.round(bestBy[c].perM * 1000) / 1000) }], {
        x: 0.5, y: 1.45 + 0.38 * (present.length + 1) + 0.25, w: 12.333, h: Math.max(2.2, 6.3 - (1.45 + 0.38 * (present.length + 1) + 0.25)),
        barDir: 'bar', catAxisOrientation: 'maxMin', chartColors: [P.purple], catAxisLabelFontSize: 10, valAxisLabelFontSize: 9, catAxisLabelFontFace: FONT, valAxisLabelFontFace: FONT,
        showValue: true, dataLabelFontSize: 9, dataLabelFormatCode: '$#,##0.000', valAxisLabelFormatCode: '$#,##0.00', valGridLine: { color: P.line, size: 0.5 },
        showLegend: false, showTitle: true, title: '$ per 1M tokens (lower is better)', titleFontSize: 11, titleColor: P.ink2,
      });
    }
    const theory = res.onprem.concat(res.cloud).some(r => r.feasible && r.basis === 'theoretical');
    if (theory) note(s3, 'On-prem and GPU-cloud throughput uses the THEORETICAL bandwidth-based estimate where no measured benchmark exists — an optimistic upper bound.');

    // 4+. Result tables (paginated)
    // Rows can wrap to two lines (long server or GPU names), so a page holds 9 to keep clear of the footnote.
    const PER = 9;
    const paged = (title, sub, head, colW, rows, rowFn, foot) => {
      if (!rows.length) return;
      const pages = Math.ceil(rows.length / PER);
      for (let p = 0; p < pages; p++) {
        const s = titled(title + (pages > 1 ? ` (${p + 1} of ${pages})` : ''), sub);
        s.addTable([hdr(head)].concat(rows.slice(p * PER, (p + 1) * PER).map(rowFn)), tableOpts(colW));
        if (foot) note(s, foot);
      }
    };
    const warnCell = r => {
      const n = uniqPlaceholders(r);
      return n ? { text: `⚠ ${n}`, options: { fill: { color: P.warn }, align: 'center' } } : '';
    };
    const on = sortRows(res.onprem).filter(r => r.feasible);
    const onHidden = res.onprem.length - on.length;
    paged('Buy servers (on-prem)', `${model ? model.name : ''} · one row per server SKU · sized in model replicas, rounded to whole nodes`,
      ['Server', 'GPU', 'Layout', 'Throughput', 'Util', 'Monthly', 'Per year', `Total (${w.term_years} yr)`, '$ / 1M', '⚠'],
      [1.8, 2.1, 2.0, 1.3, 0.65, 0.95, 0.95, 1.15, 0.9, 0.533], on,
      r => [r.name, r.sub, `${r.cost.nodes} node(s) · ${r.cost.gpus} GPUs · ${r.sizing.best.replicas}×TP${r.sizing.best.tp}${r.sizing.best.pp > 1 ? '×PP' + r.sizing.best.pp : ''}`,
        r.basis === 'theoretical' ? 'Estimate' : r.basis === 'benchmark' ? 'Measured' : basis(r), f.num(r.util * 100, 1) + '%', f.usd(r.monthly), f.usd(r.monthly * 12), f.usd(r.total), { text: f.perM(r.perM), options: { bold: true } }, warnCell(r)],
      `Throughput: Estimate = theoretical estimate, Measured = benchmark. Util = average share of installed capacity in use. ⚠ = number of placeholder values (e.g. server price quotes) the row depends on.${onHidden ? ` ${onHidden} SKU(s) cannot fit this model and are omitted.` : ''} Monthly = total ÷ months, straight-line.`);

    const cl = sortRows(res.cloud).filter(r => r.feasible);
    paged('Rent GPUs (GPU cloud)', 'Same replica sizing, priced per GPU-hour · reserved billed 24/7 · on-demand uses active hours',
      ['Provider', 'GPU / instance', 'Pricing', 'GPUs', 'Monthly', 'Per year', `Total (${w.term_years} yr)`, '$ / 1M', '⚠'],
      [1.5, 3.0, 2.4, 0.6, 1.0, 1.0, 1.2, 1.0, 0.633], cl,
      r => [r.name, r.sub, r.pricing, String(r.cost.gpus), f.usd(r.monthly), f.usd(r.monthly * 12), f.usd(r.total), { text: f.perM(r.perM), options: { bold: true } }, warnCell(r)],
      `On-demand assumes ${f.int(w.cloud_active_hours_per_month)} active hours/month. Excludes storage, egress and support plans.`);

    const apiRow = r => [r.name, r.sub, `${f.price(v(r.price.input_per_m))} / ${f.price(v(r.price.output_per_m))}`, f.usd(r.monthly), f.usd(r.monthly * 12), f.usd(r.total), { text: f.perM(r.perM), options: { bold: true } }, warnCell(r)];
    const apiFoot = `Cached-input share ${f.num(w.api_cache_hit_pct)}% · batch share ${f.num(w.api_batch_share_pct)}% · prices held flat over the term.`;
    paged('Pay per token (API) — same model', `${model ? model.name : ''} hosted by API providers · directly comparable with self-hosting`,
      ['Provider', 'Model', 'In / out per 1M', 'Monthly', 'Per year', `Total (${w.term_years} yr)`, '$ / 1M', '⚠'], [2.1, 3.0, 1.8, 1.2, 1.2, 1.4, 1.0, 0.633],
      sortRows(res.api.filter(r => r.sameModel)), apiRow, apiFoot);
    paged('Pay per token (API) — closed models', 'Different models, shown for cost context only — not a like-for-like quality comparison',
      ['Provider', 'Model', 'In / out per 1M', 'Monthly', 'Per year', `Total (${w.term_years} yr)`, '$ / 1M', '⚠'], [2.1, 3.0, 1.8, 1.2, 1.2, 1.4, 1.0, 0.633],
      sortRows(res.api.filter(r => !r.sameModel)), apiRow, apiFoot);

    // Breakeven chart
    status('Computing breakeven…');
    const be = TC.breakeven(data, w, { kMax: 100, points: 40 });
    const complete = TC.SERIES.filter(sr => be.points.every(p => p.series[sr.key]));
    const s6 = titled('Breakeven: when does buying servers pay off?', `Users scaled 0.02× – 100× this profile (peak concurrency ${w.peak_concurrency_mode === 'derived' ? 'recomputed from the traffic pattern' : 'scaled linearly'}); cheapest option per category at each volume`);
    if (complete.length) {
      s6.addChart(pptx.ChartType.line, complete.map(sr => ({
        name: sr.label,
        labels: be.points.map(p => f.tokens(p.tokensMonth)),
        values: be.points.map(p => Math.round(p.series[sr.key].monthly)),
      })), {
        x: 0.5, y: 1.4, w: 8.4, h: 5.0, chartColors: complete.map(sr => SERIES[TC.SERIES.indexOf(sr)]), lineSize: 2, lineDataSymbol: 'none',
        valAxisLogScaleBase: 10, valAxisLabelFormatCode: '$#,##0', valAxisLabelFontSize: 9, catAxisLabelFontSize: 9, catAxisLabelFrequency: 6,
        catAxisTitle: 'Tokens per month', showCatAxisTitle: true, catAxisTitleFontSize: 10, valAxisTitle: 'Monthly cost (log scale)', showValAxisTitle: true, valAxisTitleFontSize: 10,
        valGridLine: { color: P.line, size: 0.5 }, catGridLine: { style: 'none' }, showLegend: true, legendPos: 'b', legendFontSize: 10, legendFontFace: FONT,
      });
    }
    s6.addText([{ text: 'Breakeven points', options: { bold: true, fontSize: 13, color: P.ink, breakLine: true } }].concat(
      be.crossovers.map(c => ({ text: !c.hasData ? `No data for ${c.vs}.` : c.index === 0 ? `Owning servers is cheaper than ${c.vs} at every usage level shown.` : c.index > 0 ? `Owning servers becomes cheaper than ${c.vs} above ${f.tokens(c.tokensMonth)} tokens/month.` : `${c.vs.charAt(0).toUpperCase() + c.vs.slice(1)} stays cheaper up to ${f.tokens(be.points[be.points.length - 1].tokensMonth)} tokens/month.`, options: { bullet: true, fontSize: 11, color: P.ink2, breakLine: true, paraSpaceAfter: 6 } }))),
      { x: 9.1, y: 1.45, w: 3.73, h: 3.6, fontFace: FONT, valign: 'top' });
    const ratio = w.peak_concurrent_requests / Math.max(wl.avgConc24h, 1e-9);
    const bestOn = res.onprem.filter(r => r.feasible).sort((x, y) => x.perM - y.perM)[0];
    s6.addText(`Peak concurrency is ${f.num(ratio, 1)}× the 24-hour average. Self-hosted capacity is sized for peak and paid for 24/7, while API cost follows volume — utilization decides the breakeven.${bestOn ? ` At this profile the lowest-cost on-prem option is ${f.num(bestOn.util * 100, 1)}% utilized; fully utilized it would cost ${f.perM(bestOn.perMFull)} per 1M tokens.` : ''}`,
      { x: 9.1, y: 5.1, w: 3.73, h: 1.3, fontFace: FONT, fontSize: 10, color: P.ink2, fill: { color: P.tint }, margin: 0.1 });

    // Assumptions
    const a = data.assumptions;
    const aRows = [
      ['PUE', a.power.pue], ['Electricity ($/kWh)', a.power.electricity_usd_per_kwh], ['Average load (% of nameplate)', a.power.load_factor_pct],
      ['Memory overhead %', a.onprem.memory_overhead_pct], ['Support % of hardware per year', a.onprem.support_pct_per_year],
      [a.onprem.net_storage_mode === 'per_node' ? 'Networking & storage ($/node)' : 'Networking & storage (% of servers)', a.onprem.net_storage_mode === 'per_node' ? a.onprem.net_storage_usd_per_node : a.onprem.net_storage_pct_of_servers],
      ['Software ($/GPU/yr)', a.onprem.software_usd_per_gpu_per_year], ['Ops staff (FTE)', a.onprem.ops_fte],
      ['Financing rate (%/yr)', a.onprem.financing_rate_pct_per_year], ['Residual value %', a.onprem.residual_value_pct],
      ['Theoretical estimate: bandwidth efficiency %', a.throughput.roofline_bandwidth_efficiency_pct], ['Theoretical estimate: compute efficiency (MFU) %', a.throughput.roofline_compute_efficiency_pct],
    ];
    const s7 = titled('Key assumptions', 'Global values from the calculator’s data files — every value carries a source and status');
    s7.addTable([hdr(['Assumption', 'Value', 'Status', 'Source'])].concat(aRows.map(([k, x]) => [k, String(v(x)), {
      text: (x && x.status) || '', options: { fill: { color: x && x.status === 'placeholder' ? P.warn : P.white } },
    }, { text: (x && x.source) || '', options: { fontSize: 8.5, color: P.ink2 } }])), Object.assign(tableOpts([3.6, 1.0, 1.2, 6.533]), { rowH: 0.36, fontSize: 10 }));
    if (a.onprem.colo_enabled) note(s7, `Colocation included at $${v(a.onprem.colo_usd_per_kw_month)}/kW-month${a.onprem.colo_includes_power ? ' (power included)' : ''}.`);

    // Caveats
    const s8 = titled('How to read these results', 'Limitations to keep in mind when using these numbers');
    const phCount = new Set(rowsAll.flatMap(r => (r.placeholders || []).map(p => p.label))).size;
    const bullets = [
      'Throughput (tokens/sec per replica) is the least certain input. It depends on batch size, sequence lengths, inference engine and version (vLLM, TensorRT-LLM, SGLang), quantization and interconnect.',
      theory ? 'Rows marked "Theoretical estimate" use a bandwidth/compute roofline — an optimistic upper bound, not a measured benchmark. Replace with measured runs before quoting.' : 'All sized rows use measured benchmarks from the calculator’s benchmark file.',
      `${phCount} placeholder value(s) — mainly server and GPU prices, which are quote-only — affect these results. Replace them with current quotes for a firm comparison.`,
      'API prices are public list prices held flat over the term; negotiated discounts, regional uplifts and cache-write fees are not included.',
      'GPU cloud excludes storage, egress and support plans. Published reserved rates are often short-term; multi-year commitments are usually quoted lower.',
      'Closed-model API rows are a different model — cost context only, not a like-for-like quality comparison.',
      'Vendor-neutral: every option that fits is listed; ordering is alphabetical unless sorted by cost.',
    ];
    s8.addText(bullets.map(b => ({ text: b, options: { bullet: true, breakLine: true, paraSpaceAfter: 10 } })), { x: 0.5, y: 1.5, w: 12.333, h: 5.0, fontFace: FONT, fontSize: 14, color: P.ink, valign: 'top' });

    // Method
    const s9 = titled('Method', 'Formulas as implemented in the calculator');
    s9.addText([
      'Weights = parameters × bytes per parameter (FP16 = 2, FP8 = 1, INT4 = 0.5)',
      'KV cache per request = 2 × layers × KV heads × head dim × bytes × sequence length',
      'Max concurrent per replica = (TP × GPU memory ÷ (1 + overhead) − weights) ÷ KV per request',
      'Replicas = ceil(max(memory, throughput, speed) × (1 + headroom)); nodes = ceil(replicas ÷ replicas per node) [+1 spare server if N+1]',
      'On-prem = servers + network/storage + support + power (kW × load × PUE × 8,760 h × $/kWh) + optional items',
      'GPU cloud = GPUs × $/GPU-hour × 730 h (reserved) or active hours (on-demand)',
      'API = input tokens × input price + output tokens × output price, with optional cache and batch discounts',
      '$ per 1M tokens = total cost over term ÷ total tokens over term × 1,000,000',
    ].map(x => ({ text: x, options: { bullet: true, breakLine: true, paraSpaceAfter: 8 } })), { x: 0.5, y: 1.5, w: 12.333, h: 5.0, fontFace: FONT, fontSize: 14, color: P.ink, valign: 'top' });

    // Contact
    const s10 = pptx.addSlide();
    s10.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: P.purple } });
    s10.addText('Questions, comments or change requests', { x: 1.0, y: 2.4, w: 11.3, h: 0.8, fontFace: FONT, fontSize: 32, bold: true, color: P.white });
    s10.addText([{ text: 'Use Request a change in the calculator, or open the form:', options: { breakLine: true } }, { text: C.requestFormUrl, options: { hyperlink: { url: C.requestFormUrl }, color: P.white } }], { x: 1.0, y: 3.3, w: 11.3, h: 1.2, fontFace: FONT, fontSize: 20, color: P.white });
    s10.addText(C.copyright, { x: 1.0, y: 6.4, w: 11.3, h: 0.4, fontFace: FONT, fontSize: 12, color: 'E9DDFF' });

    status('Saving…');
    const safe = (model ? model.name : 'model').replace(/[^\w.-]+/g, '-');
    if (!save) { status(''); return pptx.write({ outputType: 'blob' }); }
    await pptx.writeFile({ fileName: `AI-cost-comparison-${safe}-${TC.today()}.pptx` });
    status('');
  };
})();
