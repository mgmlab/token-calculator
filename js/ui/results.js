/* Side-by-side results tables with expandable math. */
(function () {
  const TC = window.TC;
  const f = TC.fmt;
  const esc = TC.esc;

  const view = { sort: 'name', showInfeasible: false, expanded: new Set(), filters: {}, collapsed: new Set() };
  TC.resultsView = view;
  const SECTIONS = ['hybrid', 'onprem', 'cloud', 'api_same', 'api_closed'];
  SECTIONS.forEach(k => view.collapsed.add(k)); // start collapsed: the Analysis summary leads, details on demand

  // ---- Filters (GPU, server vendor, cloud provider, pricing type, API provider); reset on every page load.
  view.filters = { gpu: '', vendor: '', cloud: '', pricing: '', api: '' };
  TC.storage.remove('tc.filters'); // clear filters saved by the earlier version
  const saveFilters = () => {};
  const F = view.filters;
  TC.filtersActive = () => Object.values(F).some(Boolean) || TC.excl.count() > 0;
  TC.filterSummary = () => [
    F.gpu && 'GPU: ' + F.gpuLabel, F.vendor && 'Server vendor: ' + F.vendor, F.cloud && 'Cloud: ' + F.cloud,
    F.pricing && 'Pricing: ' + (F.pricing === 'cloud_reserved' ? 'Reserved' : 'On-demand'), F.api && 'API provider: ' + F.api,
    TC.excl.count() && TC.excl.count() + ' option(s) removed by hand',
  ].filter(Boolean).join(' · ');
  const keepOnprem = r => (!F.gpu || (r.gpu && r.gpu.id === F.gpu)) && (!F.vendor || (r.server && r.server.vendor === F.vendor));
  const keepCloud = r => (!F.gpu || r.gpu.id === F.gpu) && (!F.cloud || r.name === F.cloud) && (!F.pricing || r.category === F.pricing);
  const keepApi = r => !F.api || r.name === F.api;
  /** The result set with the current filters applied (used by the tables and by CSV/PowerPoint export). */
  TC.applyFilters = res => Object.assign({}, res, {
    onprem: res.onprem.filter(keepOnprem), cloud: res.cloud.filter(keepCloud), api: res.api.filter(keepApi),
  });

  function filterBar(res) {
    const uniq = (arr, key, label) => {
      const m = new Map();
      arr.forEach(r => { const k = key(r); if (k && !m.has(k)) m.set(k, label(r)); });
      return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    };
    const gpus = uniq(res.onprem.concat(res.cloud), r => r.gpu && r.gpu.id, r => r.gpu.name);
    const vendors = uniq(res.onprem, r => r.server && r.server.vendor, r => r.server.vendor);
    const clouds = uniq(res.cloud, r => r.name, r => r.name);
    const apis = uniq(res.api, r => r.name, r => r.name);
    const sel = (key, label, opts) => `<label>${label} <select data-filter="${key}"><option value="">All</option>${opts.map(([v, l]) => `<option value="${esc(v)}" ${F[key] === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
    return `<div class="toolbar filter-bar" role="group" aria-label="Filter results">
      <span class="muted small strong">Filter</span>
      ${sel('gpu', 'GPU', gpus)}
      ${sel('vendor', 'Server vendor', vendors)}
      ${sel('cloud', 'Cloud', clouds)}
      ${sel('pricing', 'Pricing', [['cloud_ondemand', 'On-demand'], ['cloud_reserved', 'Reserved']])}
      ${sel('api', 'API provider', apis)}
      ${TC.filtersActive() ? '<button class="btn ghost small" data-view="clear-filters">Clear filters</button>' : ''}
    </div>`;
  }

  function sortRows(rows) {
    const byName = (a, b) => (a.name + ' ' + a.sub).localeCompare(b.name + ' ' + b.sub);
    return rows.slice().sort((a, b) => {
      if (a.feasible !== b.feasible) return a.feasible ? -1 : 1;
      if (view.sort === 'cost' && a.feasible && b.feasible) return a.perM - b.perM;
      return byName(a, b);
    });
  }

  function warnBadge(row) {
    const n = (row.placeholders || []).length;
    const uniq = new Set((row.placeholders || []).map(p => p.label)).size;
    return n ? `<span class="badge st-placeholder" title="Uses ${uniq} placeholder value(s) — see the math panel">⚠ ${uniq}</span>` : '';
  }

  /** Row buttons: jump to the record in the Data editor, or remove the option from this analysis. */
  function acts(r) {
    const e = [], x = { kind: 'rows', id: r.id, label: r.name + ' · ' + r.sub };
    if (r.category === 'onprem') {
      if (r.server) e.push(['servers', r.server.id, 'Server', '']);
      if (r.gpu) e.push(['gpus', r.gpu.id, 'GPU', '']);
      if (r.server) Object.assign(x, { kind: 'servers', id: r.server.id, label: 'Server: ' + r.name + ' (' + r.sub + ')' });
    } else if (r.category === 'api') {
      e.push(['models', r.model.id, 'Pricing', 'api_prices']);
      x.label = 'API: ' + r.name + ' · ' + r.sub;
    } else {
      e.push(['gpus', r.gpu.id, 'Pricing', 'cloud']);
      x.label = 'Cloud: ' + r.name + ' · ' + r.sub + ' (' + r.pricing + ')';
    }
    return `<span class="row-acts">${e.map(([ds, id, l, path]) => `<button type="button" class="row-act" data-edit="${esc(ds + '|' + id + '|' + path)}" title="Open this ${ds === 'models' ? 'model’s API prices' : ds === 'gpus' ? (path ? 'GPU’s cloud prices' : 'GPU') : 'server'} in the Data editor">✎ ${l}</button>`).join('')}<button type="button" class="row-act x" data-exclude="${esc(x.kind + '|' + x.id)}" data-label="${esc(x.label)}" title="Remove from this analysis (the data is kept; bring it back from the list above the tables)">✕</button></span>`;
  }

  function exclBar() {
    const xs = TC.excl.list();
    if (!xs.length) return '';
    return `<div class="excl-bar"><strong>Removed from this analysis (${xs.length}):</strong>
      ${xs.map(o => `<span class="excl-chip">${esc(o.label)}<button type="button" data-restore="${esc(o.kind + '|' + o.id)}" title="Bring back" aria-label="Bring back ${esc(o.label)}">↺</button></span>`).join('')}
      <button type="button" class="btn ghost small" data-restore-all>Bring all back</button></div>`;
  }

  function flagBadge(row) {
    const n = (row.flags || []).length;
    return n ? `<span class="badge flag" title="${esc(row.flags.join('\n'))}">! ${n}</span>` : '';
  }

  function table(title, subtitle, cols, allRows, cellsFn, wl, csvKey, keep) {
    const rows = keep ? allRows.filter(keep) : allRows;
    const vis = sortRows(rows).filter(r => r.feasible || view.showInfeasible);
    const hidden = rows.filter(r => !r.feasible).length;
    const closed = csvKey && view.collapsed.has(csvKey);
    const fits = rows.filter(r => r.feasible).length;
    let h = `<section class="card result-block ${closed ? 'collapsed' : ''}">
      <div class="block-head"><div><h3><button type="button" class="sect-toggle" data-section="${csvKey}" aria-expanded="${!closed}" title="${closed ? 'Expand' : 'Collapse'} this section">${closed ? '▸' : '▾'} ${esc(title)}</button></h3>
        ${closed
          ? `<p class="muted">${allRows.length} option${allRows.length === 1 ? '' : 's'}${rows.length < allRows.length ? ` — ${rows.length} match the current filters` : ''}${fits < rows.length ? ` · ${fits} fit this workload` : ''}${csvKey && csvKey.startsWith('api') && view.apiExcluded ? ` · ${view.apiExcluded} provider${view.apiExcluded > 1 ? 's' : ''} excluded in Advanced settings` : ''}. Click the heading to expand.</p>`
          : `<p class="muted">${subtitle}</p>`}</div>
      <div class="block-actions">${rows.length < allRows.length ? `<span class="badge filtered">Filtered: ${rows.length} of ${allRows.length}</span>` : ''}${hidden && !view.showInfeasible ? `<span class="muted small">${hidden} option(s) don't fit — tick "show options that don't fit"</span>` : ''}
      ${rows.length && csvKey ? `<button class="btn ghost small" data-export="${csvKey}" title="Download this table as CSV (opens in Excel)">CSV</button>` : ''}</div></div>`;
    if (closed) return h + '</section>';
    if (!rows.length) return h + (allRows.length ? '<p class="empty">No options match the current filters.</p></section>' : '<p class="empty">No options available for this model. Add entries in the Data editor.</p></section>');
    h += `<div class="table-wrap"><table class="results-table"><thead><tr><th></th>${cols.map(c => `<th class="${c.num ? 'num' : ''}">${c.label}</th>`).join('')}</tr></thead><tbody>`;
    vis.forEach(r => {
      const open = view.expanded.has(r.id);
      h += `<tr class="row ${r.feasible ? '' : 'infeasible'} ${open ? 'open' : ''}" data-id="${esc(r.id)}" tabindex="0" aria-expanded="${open}">
        <td class="chev">${open ? '▾' : '▸'}</td>${cellsFn(r)}</tr>`;
      if (open) h += `<tr class="detail"><td></td><td colspan="${cols.length}">${r.feasible ? TC.renderMath(r, wl) : renderInfeasible(r)}</td></tr>`;
    });
    return h + '</tbody></table></div></section>';
  }

  function renderInfeasible(r) {
    let h = `<div class="math-panel"><p class="callout">Does not fit: ${esc(r.reason || '')}</p>`;
    if (r.sizing) {
      h += TC.renderSteps('Sizing — model memory', r.sizing.shared.steps);
      r.sizing.candidates.forEach(c => { h += TC.renderSteps(`TP ${c.tp}${c.pp > 1 ? ' × PP ' + c.pp : ''}`, c.steps); });
    }
    return h + '</div>';
  }

  const money = r => r.feasible
    ? `<td class="num">${f.usd(r.monthly)}</td><td class="num">${f.usd(r.total)}</td><td class="num strong">${f.perM(r.perM)}</td>`
    : `<td class="num muted" colspan="3">${esc(r.reason || 'n/a')}</td>`;
  const utilCell = r => r.feasible
    ? `<td class="num" title="Average share of installed capacity in use${r.perMFull != null ? ' · fully utilized: ' + f.perM(r.perMFull) + ' per 1M tokens' : ''}">${f.num(r.util * 100, 1)}%</td>`
    : '<td></td>';
  const moneyCols = [{ label: 'Monthly', num: true }, { label: 'Total over term', num: true }, { label: '$ / 1M tokens', num: true }];

  TC.renderResults = function (el, res, w, data) {
    const wl = res.wl;
    const model = data.models.models.find(m => m.id === w.model_id);
    // Notes that explain confidence live inside the summary card's Confidence section.
    const notes = [];
    const anyTheory = res.onprem.concat(res.cloud).some(r => r.feasible && r.basis === 'theoretical');
    notes.push(`<strong>Throughput:</strong> tokens/sec per replica depends on batch size, sequence length and inference engine (vLLM, TensorRT-LLM, SGLang…).
      ${anyTheory ? 'Rows marked <span class="badge basis-theory">theoretical estimate</span> use the theoretical bandwidth-based estimate, not a measured benchmark — treat them as an optimistic upper bound.' : ''}
      Expand any row to see the exact benchmark or estimate used.`);
    const bestOn = res.onprem.filter(r => r.feasible).sort((a, b) => a.perM - b.perM)[0];
    if (bestOn && bestOn.util < 0.3) {
      notes.push("<strong>Utilization:</strong> " + esc(`Self-hosted capacity is only ${f.num(bestOn.util * 100, 1)}% utilized on average (sized for peak concurrency of ${f.int(w.peak_concurrent_requests)}). Fully utilized, the lowest-cost on-prem option would be ${f.perM(bestOn.perMFull)} per 1M tokens instead of ${f.perM(bestOn.perM)}. Utilization — not hardware price — is usually what decides on-prem vs API.`));
    }
    let h = execCard(data, w, res, notes);

    h += `<div class="summary">
      <div class="stat"><span class="label">Tokens / month</span><span class="value">${f.tokens(wl.tMo)}</span><span class="muted small">${f.tokens(wl.tInMo)} in · ${f.tokens(wl.tOutMo)} out</span></div>
      <div class="stat"><span class="label">Tokens over ${w.term_years} yr</span><span class="value">${f.tokens(wl.tTerm)}</span></div>
      <div class="stat"><span class="label">Required output throughput</span><span class="value">${f.int(w.peak_concurrent_requests * w.target_output_tps_per_request)} tok/s</span><span class="muted small">${f.int(w.peak_concurrent_requests)} concurrent × ${f.num(w.target_output_tps_per_request)} tok/s</span></div>
      <div class="stat"><span class="label">Model</span><span class="value sm">${model ? `<button type="button" class="edit-link" data-edit="models|${esc(model.id)}|" title="Open this model in the Data editor">${esc(model.name)}</button>` : '—'}</span><span class="muted small">${esc(w.precision)} weights · ${esc(w.kv_precision)} KV</span></div>
    </div>`;

    // Input sanity warnings (e.g. peak below the average) stay visible — they point at a likely typo.
    wl.flags.forEach(x => { h += `<p class="callout">${esc(x)}</p>`; });

    h += `<div class="toolbar">
      <label>Sort <select data-view="sort"><option value="name" ${view.sort === 'name' ? 'selected' : ''}>Alphabetical</option><option value="cost" ${view.sort === 'cost' ? 'selected' : ''}>$ / 1M tokens</option></select></label>
      <label class="check"><input type="checkbox" data-view="showInfeasible" ${view.showInfeasible ? 'checked' : ''}> Show options that don't fit</label>
      <button class="btn ghost small" data-view="collapse">${SECTIONS.every(k => view.collapsed.has(k)) ? 'Expand all' : 'Collapse all'}</button>
      <span class="toolbar-spacer"></span>
      <button class="btn ghost small" data-export="all" title="All tables plus the workload profile in one CSV (opens in Excel)">Export CSV</button>
      <button class="btn small" data-export="pptx" title="Generate a PowerPoint deck with every result on its own slide">Export PowerPoint</button>
      <span class="export-status muted small" aria-live="polite"></span>
    </div>` + filterBar(res) + exclBar();

    {
      const closed = view.collapsed.has('hybrid');
      h += `<section class="card result-block ${closed ? 'collapsed' : ''}">
        <div class="block-head"><div><h3><button type="button" class="sect-toggle" data-section="hybrid" aria-expanded="${!closed}">${closed ? '▸' : '▾'} Hybrid — owned baseline + pay-per-token overflow</button></h3>
          <p class="muted">${closed ? 'Finds the cheapest split between owned GPUs and the API. Click the heading to expand.' : 'Own enough GPUs for the steady part of demand; send busy-hour overflow to the cheapest same-model API.'}</p></div></div>
        ${closed ? '' : `<div class="hy-wrap" id="hybrid-body">${TC.lastExec && TC.lastExec.hybrid !== undefined && TC.lastExecKey === JSON.stringify(w) ? hybridBody(TC.lastExec.hybrid) : '<p class="muted">Working out the best mix…</p>'}</div>`}
      </section>`;
    }

    h += table('Buy servers (on-prem)', 'Purchase GPU servers and run the model yourself. One row per server model; sized in model copies (replicas), rounded to whole servers.',
      [{ label: 'Server' }, { label: 'GPU' }, { label: 'Layout' }, { label: 'Throughput basis' }, { label: 'Avg util', num: true }, ...moneyCols, { label: '' }],
      res.onprem,
      r => `<td><strong>${esc(r.name)}</strong></td><td>${esc(r.sub)}</td>
        <td>${r.feasible ? `${r.cost.nodes} node${r.cost.nodes > 1 ? 's' : ''} · ${r.cost.gpus} GPUs<br><span class="muted small">${r.sizing.best.replicas} × TP${r.sizing.best.tp}${r.sizing.best.pp > 1 ? '×PP' + r.sizing.best.pp : ''}</span>` : '—'}</td>
        <td>${r.feasible ? TC.basisLabel(r.basis, r.sizing.best.lab) : ''}</td>${utilCell(r)}${money(r)}<td class="badges">${warnBadge(r)}${flagBadge(r)}${acts(r)}</td>`, wl, 'onprem', keepOnprem);

    h += table('Rent GPUs (GPU cloud)', 'Rent the same GPUs from a cloud provider and run the model yourself. Reserved = committed, billed 24/7; on-demand = pay by the hour while running.',
      [{ label: 'Provider' }, { label: 'GPU / instance' }, { label: 'Pricing' }, { label: 'GPUs' }, { label: 'Avg util', num: true }, ...moneyCols, { label: '' }],
      res.cloud,
      r => `<td><strong>${esc(r.name)}</strong></td><td>${esc(r.sub)}</td><td>${esc(r.pricing)}</td>
        <td>${r.feasible ? r.cost.gpus : '—'}</td>${utilCell(r)}${money(r)}<td class="badges">${warnBadge(r)}${flagBadge(r)}${acts(r)}</td>`, wl, 'cloud', keepCloud);

    const same = res.api.filter(r => r.sameModel);
    const closed = res.api.filter(r => !r.sameModel);
    const exN = (w.api_excluded || []).length;
    view.apiExcluded = exN;
    h += table('Pay per token (API) — same model', `A provider runs ${esc(model ? model.name : '')} for you; you pay per token used. Directly comparable with buying or renting GPUs.${exN ? ` <strong>${exN} provider${exN > 1 ? 's' : ''} excluded</strong> under Advanced settings (${esc(w.api_excluded.join(', '))}).` : ''}`,
      [{ label: 'Provider' }, { label: 'Model' }, { label: 'In / out per 1M' }, ...moneyCols, { label: '' }],
      same, apiCells, wl, 'api_same', keepApi);
    if (w.include_closed_models) {
      h += table('Pay per token (API) — other models', 'Different models (GPT, Claude, Gemini…), shown for cost context only — not a like-for-like quality comparison.' + (w.closed_tier && w.closed_tier !== 'all' ? ` Showing the <strong>${esc(w.closed_tier)}</strong> tier only (Advanced settings).` : ' All tiers shown; the cheapest is usually a budget model.'),
        [{ label: 'Provider' }, { label: 'Model' }, { label: 'In / out per 1M' }, ...moneyCols, { label: '' }],
        closed, apiCells, wl, 'api_closed', keepApi);
    }

    el.innerHTML = h;
  };

  // The summary needs a breakeven sweep (~0.5 s), so the tables render first and the card fills in right after.
  let execToken = 0;
  function execCard(data, w, res, notes) {
    const my = ++execToken;
    setTimeout(() => {
      if (my !== execToken) return; // inputs changed again; a newer render will fill it
      const el = document.getElementById('exec-card');
      if (el) el.outerHTML = execCardHtml(data, w, res, notes);
      const hb = document.getElementById('hybrid-body');
      if (hb && TC.lastExec) hb.innerHTML = hybridBody(TC.lastExec.hybrid);
    }, 30);
    return `<section class="card exec" id="exec-card"><div class="exec-head"><h2>Analysis summary</h2></div><p class="muted">Working out the best option…</p></section>`;
  }

  function execCardHtml(data, w, res, notes) {
    let x;
    try { x = TC.execSummary(data, w, res); } catch (e) { console.error(e); return ''; }
    TC.lastExec = x;
    TC.lastExecKey = JSON.stringify(w);
    const tile = (label, r, rng, note, desc) => r
      ? `<div class="exec-tile"><span class="label">${label}</span><span class="value">${TC.fmtRangeYear(rng, r.monthly)}<small>/yr</small></span>
          <span class="muted small">${esc(desc || r.name + ' · ' + r.sub)}</span><span class="muted small">${f.perM(r.perM)} per 1M tokens${note ? ' · ' + note : ''}</span></div>`
      : `<div class="exec-tile"><span class="label">${label}</span><span class="value muted">—</span><span class="muted small">No option fits</span></div>`;
    let be;
    if (x.multiple === 0) be = `Owning servers is <strong>already cheaper</strong> than ${x.altLabel} at today's volume.`;
    else if (isFinite(x.multiple)) be = `Owning servers becomes cheaper than ${x.altLabel} at about <strong>${f.tokens(x.breakevenTokens)} tokens/month</strong> — <strong>${f.num(x.multiple, x.multiple < 10 ? 1 : 0)}×</strong> today's usage.`;
    else be = `${x.altLabel.charAt(0).toUpperCase() + x.altLabel.slice(1)} stays cheaper than owning servers up to <strong>2,000×</strong> today's usage.`;
    const name = w.scenario_name ? `<span class="exec-scn">${esc(w.scenario_name)}</span>` : '';
    return `<section class="card exec" id="exec-card">
      <div class="exec-head"><div><h2>Analysis summary ${name}</h2><p class="muted small">Lowest-cost option in each category over ${w.term_years} years, shown per year. Ranges reflect the uncertain inputs below.</p></div>
        <span class="verdict v-${x.verdict.tone}">${esc(x.verdict.label)}</span></div>
      <div class="exec-tiles">
        ${tile('Buy servers (on-prem)', x.on, x.onRange, x.on ? f.num(x.on.util * 100, x.on.util < 0.01 ? 1 : 0) + '% utilized' : '', x.onLabel)}
        ${tile('Rent GPUs (GPU cloud)', x.cl, x.clRange, x.cl ? x.cl.pricing : '')}
        ${tile('Pay per token (same model)', x.api, null, '')}
        ${hybridTile(x.hybrid)}
      </div>
      <p class="exec-be">${be}</p>
      <p class="exec-why"><strong>Why:</strong> ${esc(x.why)}</p>
      <details class="exec-conf"><summary>Confidence: <span class="conf conf-${x.level.toLowerCase()}">${x.level}</span> — ${x.level === 'High' ? 'key inputs are measured or current' : 'treat as directional until the ⚠ items are firmed up'}</summary>
        <ul>${x.checks.map(c => `<li>${c.ok ? '✓' : '⚠'} <strong>${esc(c.label)}:</strong> ${esc(c.detail)}</li>`).join('')}</ul>
        ${(notes || []).map(n => `<p class="conf-note">${n}</p>`).join('')}
        <p class="muted small">Ranges come from rerunning the calculation with optimistic and pessimistic values for throughput efficiency, placeholder server prices and power load. API prices are published list prices, so they carry no range.</p>
      </details>
    </section>`;
  }

  function hybridTile(hy) {
    if (!hy) return `<div class="exec-tile"><span class="label">Hybrid (owned baseline + API)</span><span class="value muted">—</span><span class="muted small">Needs a same-model API price</span></div>`;
    const b = hy.best;
    const note = b.share <= 0.05 ? 'best mix is all API' : b.share >= 0.95 ? 'best mix is all owned' : `${f.num(b.share * 100, 0)}% of tokens on owned GPUs`;
    return `<div class="exec-tile ${hy.wins ? 'hy-win' : ''}"><span class="label">Hybrid (owned baseline + API)</span><span class="value">${f.usdCompact(b.total * 12)}<small>/yr</small></span>
      <span class="muted small">${b.row ? esc(b.setup) + ' + ' + esc(hy.api.name) : esc(hy.api.name) + ' only'}</span><span class="muted small">${note}</span></div>`;
  }

  // Hybrid section body (filled after the summary is computed).
  function hybridBody(hy) {
    if (!hy) return '<p class="empty">A hybrid needs both an on-prem option that fits and a same-model API price.</p>';
    const b = hy.best, pts = hy.points;
    // Shown per year to match the summary tile. Three lines: owned hardware, API overflow, and their sum.
    const Y12 = v => v * 12;
    const W = 860, H = 300, M = { l: 76, r: 150, t: 18, b: 46 };
    const ys = pts.map(p => Y12(Math.max(p.total, p.ownedMonthly, p.apiMonthly))).concat([Y12(hy.onPremOnly)]);
    const top = Math.max(...ys) * 1.05, raw = top / 4, pw = Math.pow(10, Math.floor(Math.log10(raw)));
    const stepY = [1, 2, 2.5, 5, 10].map(m => m * pw).find(x => x >= raw);
    const yMax = Math.ceil(top / stepY) * stepY;
    const X = pct => M.l + pct / 100 * (W - M.l - M.r), Y = v => H - M.b - v / yMax * (H - M.t - M.b);
    const path = key => pts.map((p, i) => (i ? 'L' : 'M') + X(p.pct).toFixed(1) + ' ' + Y(Y12(p[key])).toFixed(1)).join(' ');
    const ticks = []; for (let t = 0; t <= yMax + 1e-9; t += stepY) ticks.push(t);
    const last = pts[pts.length - 1];
    let svg = `<svg viewBox="0 0 ${W} ${H}" class="hy-chart" role="img" aria-label="Yearly cost by how much of peak demand you own GPUs for">`;
    ticks.forEach(t => { svg += `<line class="grid" x1="${M.l}" x2="${W - M.r}" y1="${Y(t)}" y2="${Y(t)}"/><text class="tick" x="${M.l - 8}" y="${Y(t) + 4}" text-anchor="end">${f.usdCompact(t)}</text>`; });
    [0, 25, 50, 75, 100].forEach(p => { svg += `<text class="tick" x="${X(p)}" y="${H - M.b + 18}" text-anchor="middle">${p}%</text>`; });
    svg += `<text class="axis-label" x="${(M.l + W - M.r) / 2}" y="${H - 6}" text-anchor="middle">Owned GPU capacity, as % of peak demand (0% = all API)</text>`;
    svg += `<text class="axis-label" transform="translate(16 ${(M.t + H - M.b) / 2}) rotate(-90)" text-anchor="middle">Cost per year</text>`;
    svg += `<line class="ref" x1="${M.l}" x2="${W - M.r}" y1="${Y(Y12(hy.onPremOnly))}" y2="${Y(Y12(hy.onPremOnly))}"/>`;
    svg += `<path d="${path('ownedMonthly')}" fill="none" stroke="var(--muted)" stroke-width="1.5"/>`;
    svg += `<path d="${path('apiMonthly')}" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="5 4"/>`;
    svg += `<path d="${path('total')}" fill="none" stroke="var(--accent)" stroke-width="2.5"/>`;
    // Direct labels at the right end of each line (nudged apart if they collide).
    const ends = [['Total', Y(Y12(last.total)), 'hy-best'], ['Owned GPUs', Y(Y12(last.ownedMonthly)), 'tick'], ['API overflow', Y(Y12(last.apiMonthly)), 'tick'], [`All owned: ${f.usdCompact(Y12(hy.onPremOnly))}`, Y(Y12(hy.onPremOnly)), 'ref-label']].sort((p, q) => p[1] - q[1]);
    for (let i = 1; i < ends.length; i++) if (ends[i][1] - ends[i - 1][1] < 14) ends[i][1] = ends[i - 1][1] + 14;
    ends.forEach(([l, y, c]) => { svg += `<text class="${c}" x="${W - M.r + 8}" y="${y + 4}">${l}</text>`; });
    pts.forEach(p => { svg += `<circle cx="${X(p.pct)}" cy="${Y(Y12(p.total))}" r="9" fill="transparent"><title>${p.pct}% of peak owned${p.row ? ' (' + p.setup + ')' : ''}\nOwned GPUs: ${f.usd(Y12(p.ownedMonthly))}/yr\nAPI overflow: ${f.usd(Y12(p.apiMonthly))}/yr\nTotal: ${f.usd(Y12(p.total))}/yr</title></circle>`; });
    svg += `<circle cx="${X(b.pct)}" cy="${Y(Y12(b.total))}" r="7" fill="var(--surface)" stroke="var(--accent)" stroke-width="3" pointer-events="none"/>`;
    const lx = X(b.pct) > (W - M.r) * 0.6 ? X(b.pct) - 12 : X(b.pct) + 12;
    svg += `<text class="hy-best" x="${lx}" y="${Y(Y12(b.total)) - 12}" text-anchor="${X(b.pct) > (W - M.r) * 0.6 ? 'end' : 'start'}">Lowest total: ${f.usdCompact(Y12(b.total))}/yr at ${b.pct}%</text>`;
    svg += '</svg>';
    const legend = `<div class="hy-legend"><span><i style="border-color:var(--accent)"></i>Total = owned + API overflow</span><span><i style="border-color:var(--muted)"></i>Owned GPUs</span><span><i style="border-color:var(--muted);border-top-style:dashed"></i>API overflow</span><span><i style="border-color:var(--muted);border-top-style:dotted"></i>All owned, sized for peak + headroom (no API)</span></div>
      <p class="muted small">Read left to right: owning more GPUs moves tokens off the API. Owned cost rises in steps because hardware comes in whole servers; where it stays flat, one server already covers that share. Hover a point for the numbers.</p>`;
    const rows = pts.filter(p => p.pct % 25 === 0 || p === b);
    const tbl = `<div class="table-wrap"><table class="results-table compact"><thead><tr><th>Owned capacity</th><th>Owned setup</th><th class="num">Tokens on owned GPUs</th><th class="num">Owned / yr</th><th class="num">API overflow / yr</th><th class="num">Total / yr</th><th class="num">vs all-API</th></tr></thead><tbody>` +
      rows.map(p => `<tr class="${p === b ? 'hy-row-best' : ''}"><td>${p.pct}% of peak${p === b ? ' <span class="badge basis-bench">lowest</span>' : ''}</td><td>${p.row ? esc(p.setup) : 'none (all API)'}</td>
        <td class="num">${f.num(p.share * 100, 0)}%</td><td class="num">${f.usd(p.ownedMonthly * 12)}</td><td class="num">${f.usd(p.apiMonthly * 12)}</td><td class="num strong">${f.usd(p.total * 12)}</td>
        <td class="num">${p.pct === 0 ? '—' : p.total <= hy.apiOnly ? '−' + f.usd((hy.apiOnly - p.total) * 12) : '+' + f.usd((p.total - hy.apiOnly) * 12)}</td></tr>`).join('') + '</tbody></table></div>';
    const verdict = hy.wins
      ? `Owning a baseline sized for <strong>${b.pct}%</strong> of peak and sending the overflow to <strong>${esc(hy.api.name)}</strong> is the lowest-cost mix — about <strong>${f.usdCompact(hy.savingsVsApi * 12)}/yr</strong> less than all-API${hy.savingsVsOnPrem > 0 ? ` and ${f.usdCompact(hy.savingsVsOnPrem * 12)}/yr less than owning for the full peak` : ''}.`
      : b.share <= 0.05 ? (() => {
        const o = pts.filter(p => p.row).sort((p, q) => p.ownedMonthly - q.ownedMonthly)[0];
        return 'At this volume the lowest-cost mix is <strong>all API</strong>: owned capacity costs more than the tokens it would serve.' + (o
          ? ` Even the smallest owned setup (${esc(o.setup)}) costs <strong>${f.usdCompact(o.ownedMonthly * 12)}/yr</strong> and already serves ${f.num(o.share * 100, 0)}% of demand at ${o.pct}% of peak, versus <strong>${f.usdCompact(hy.apiOnly * 12)}/yr</strong> for all API — which is why the line jumps and then stays flat.`
          : '');
      })()
      : b.share >= 0.95 ? 'At this volume the lowest-cost mix is <strong>all owned</strong>: overflow to the API costs more than owning for the peak.'
      : `A mix at ${b.pct}% of peak is cheapest, but saves less than 5% versus the best single option.`;
    return `<p class="hy-verdict">${verdict}</p>${svg}${legend}${tbl}
      <details class="hy-how"><summary>How this is calculated</summary>${TC.renderSteps('Hybrid', hy.steps)}
        <p class="muted small">Assumes requests can be routed to either owned GPUs or the API (e.g. through a gateway), and that the same model runs on both. Filters don't apply to this section.</p></details>`;
  }

  const TIER = { budget: 'budget tier', mid: 'mid tier', frontier: 'frontier tier' };
  function apiCells(r) {
    return `<td><strong>${esc(r.name)}</strong></td><td>${esc(r.sub)}${!r.sameModel && r.model.tier ? ` <span class="muted small">· ${TIER[r.model.tier] || esc(r.model.tier)}</span>` : ''}</td>
      <td class="nowrap">${f.price(TC.v(r.price.input_per_m))} / ${f.price(TC.v(r.price.output_per_m))}</td>${money(r)}<td class="badges">${warnBadge(r)}${flagBadge(r)}${acts(r)}</td>`;
  }

  /** Wires clicks once; the container is re-rendered on every change. */
  TC.bindResults = function (el, rerender) {
    el.addEventListener('click', async e => {
      const ex = e.target.closest('[data-export]');
      if (ex) {
        const st = el.querySelector('.export-status');
        TC.track('export-' + ex.dataset.export, 'Export ' + ex.dataset.export);
        if (ex.dataset.export === 'pptx') {
          ex.disabled = true;
          try { await TC.exportPptx(msg => { if (st) st.textContent = msg; }); }
          catch (err) { if (st) st.textContent = ''; alert('PowerPoint export failed: ' + err.message); }
          ex.disabled = false;
        } else TC.exportCsv(ex.dataset.export);
        return;
      }
      const ed = e.target.closest('[data-edit]');
      if (ed) {
        const [ds, id, path] = ed.dataset.edit.split('|');
        TC.track('edit-from-compare', 'Opened ' + ds + ' from Compare');
        TC.showTab('data');
        TC.editor.open(ds, id, path || undefined);
        return;
      }
      const xb = e.target.closest('[data-exclude]');
      if (xb) {
        const [kind, id] = xb.dataset.exclude.split('|');
        TC.track('exclude-compare', 'Removed an option on Compare');
        view.expanded.delete(xb.closest('tr') && xb.closest('tr').dataset.id);
        TC.excl.set(kind, [id], true, [xb.dataset.label]);
        return;
      }
      const rb = e.target.closest('[data-restore]');
      if (rb) { const [kind, id] = rb.dataset.restore.split('|'); TC.excl.set(kind, [id], false); return; }
      if (e.target.closest('[data-restore-all]')) { TC.excl.clear(); return; }
      const sect = e.target.closest('[data-section]');
      if (sect) { const k = sect.dataset.section; if (view.collapsed.has(k)) view.collapsed.delete(k); else view.collapsed.add(k); rerender(); return; }
      const ctl = e.target.closest('[data-view]');
      if (ctl && ctl.dataset.view === 'collapse') {
        const allClosed = SECTIONS.every(k => view.collapsed.has(k));
        view.expanded.clear();
        if (allClosed) view.collapsed.clear(); else SECTIONS.forEach(k => view.collapsed.add(k));
        rerender();
        return;
      }
      if (ctl && ctl.dataset.view === 'clear-filters') { Object.keys(F).forEach(k => { F[k] = ''; }); saveFilters(); rerender(); return; }
      if (e.target.closest('.detail')) return;
      const tr = e.target.closest('tr.row');
      if (!tr) return;
      const id = tr.dataset.id;
      if (view.expanded.has(id)) view.expanded.delete(id); else view.expanded.add(id);
      rerender();
    });
    el.addEventListener('keydown', e => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr.row')) { e.preventDefault(); e.target.click(); }
    });
    el.addEventListener('change', e => {
      const fl = e.target.closest('[data-filter]');
      if (fl) {
        F[fl.dataset.filter] = fl.value;
        if (fl.dataset.filter === 'gpu') F.gpuLabel = fl.value ? fl.options[fl.selectedIndex].text : '';
        saveFilters();
        if (fl.value) TC.track('filter-' + fl.dataset.filter, 'Filtered by ' + fl.dataset.filter);
        rerender();
        return;
      }
      const ctl = e.target.closest('[data-view]');
      if (!ctl) return;
      if (ctl.dataset.view === 'sort') view.sort = ctl.value;
      if (ctl.dataset.view === 'showInfeasible') view.showInfeasible = ctl.checked;
      rerender();
    });
  };
})();
