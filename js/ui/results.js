/* Side-by-side results tables with expandable math. */
(function () {
  const TC = window.TC;
  const f = TC.fmt;
  const esc = TC.esc;

  const view = { sort: 'name', showInfeasible: false, expanded: new Set(), filters: {} };
  TC.resultsView = view;

  // ---- Filters (GPU, server vendor, cloud provider, pricing type, API provider); reset on every page load.
  view.filters = { gpu: '', vendor: '', cloud: '', pricing: '', api: '' };
  TC.storage.remove('tc.filters'); // clear filters saved by the earlier version
  const saveFilters = () => {};
  const F = view.filters;
  TC.filtersActive = () => Object.values(F).some(Boolean);
  TC.filterSummary = () => [
    F.gpu && 'GPU: ' + F.gpuLabel, F.vendor && 'Server vendor: ' + F.vendor, F.cloud && 'Cloud: ' + F.cloud,
    F.pricing && 'Pricing: ' + (F.pricing === 'cloud_reserved' ? 'Reserved' : 'On-demand'), F.api && 'API provider: ' + F.api,
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

  function flagBadge(row) {
    const n = (row.flags || []).length;
    return n ? `<span class="badge flag" title="${esc(row.flags.join('\n'))}">! ${n}</span>` : '';
  }

  function table(title, subtitle, cols, allRows, cellsFn, wl, csvKey, keep) {
    const rows = keep ? allRows.filter(keep) : allRows;
    const vis = sortRows(rows).filter(r => r.feasible || view.showInfeasible);
    const hidden = rows.filter(r => !r.feasible).length;
    let h = `<section class="card result-block">
      <div class="block-head"><div><h3>${esc(title)}</h3><p class="muted">${subtitle}</p></div>
      <div class="block-actions">${rows.length < allRows.length ? `<span class="badge filtered">Filtered: ${rows.length} of ${allRows.length}</span>` : ''}${hidden && !view.showInfeasible ? `<span class="muted small">${hidden} option(s) don't fit — tick "show options that don't fit"</span>` : ''}
      ${rows.length && csvKey ? `<button class="btn ghost small" data-export="${csvKey}" title="Download this table as CSV (opens in Excel)">CSV</button>` : ''}</div></div>`;
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
    let h = '';

    h += `<div class="summary">
      <div class="stat"><span class="label">Tokens / month</span><span class="value">${f.tokens(wl.tMo)}</span><span class="muted small">${f.tokens(wl.tInMo)} in · ${f.tokens(wl.tOutMo)} out</span></div>
      <div class="stat"><span class="label">Tokens over ${w.term_years} yr</span><span class="value">${f.tokens(wl.tTerm)}</span></div>
      <div class="stat"><span class="label">Required output throughput</span><span class="value">${f.int(w.peak_concurrent_requests * w.target_output_tps_per_request)} tok/s</span><span class="muted small">${f.int(w.peak_concurrent_requests)} concurrent × ${f.num(w.target_output_tps_per_request)} tok/s</span></div>
      <div class="stat"><span class="label">Model</span><span class="value sm">${esc(model ? model.name : '—')}</span><span class="muted small">${esc(w.precision)} weights · ${esc(w.kv_precision)} KV</span></div>
    </div>`;

    const wflags = wl.flags.slice();
    const bestOn = res.onprem.filter(r => r.feasible).sort((a, b) => a.perM - b.perM)[0];
    if (bestOn && bestOn.util < 0.3) {
      wflags.push(`Self-hosted capacity is only ${f.num(bestOn.util * 100, 1)}% utilized on average (sized for peak concurrency of ${f.int(w.peak_concurrent_requests)}). Fully utilized, the lowest-cost on-prem option would be ${f.perM(bestOn.perMFull)} per 1M tokens instead of ${f.perM(bestOn.perM)}. Utilization — not hardware price — is usually what decides on-prem vs API.`);
    }
    const anyTheory = res.onprem.concat(res.cloud).some(r => r.feasible && r.basis === 'theoretical');
    h += `<p class="callout warn"><strong>Throughput caveat:</strong> tokens/sec per replica depends on batch size, sequence length and inference engine (vLLM, TensorRT-LLM, SGLang…).
      ${anyTheory ? 'Rows marked <span class="badge basis-theory">theoretical estimate</span> use the theoretical bandwidth-based estimate, not a measured benchmark — treat them as an optimistic upper bound.' : ''}
      Expand any row to see the exact benchmark or estimate used.</p>`;
    wflags.forEach(x => { h += `<p class="callout">${esc(x)}</p>`; });

    h += `<div class="toolbar">
      <label>Sort <select data-view="sort"><option value="name" ${view.sort === 'name' ? 'selected' : ''}>Alphabetical</option><option value="cost" ${view.sort === 'cost' ? 'selected' : ''}>$ / 1M tokens</option></select></label>
      <label class="check"><input type="checkbox" data-view="showInfeasible" ${view.showInfeasible ? 'checked' : ''}> Show options that don't fit</label>
      <button class="btn ghost small" data-view="collapse">Collapse all</button>
      <span class="toolbar-spacer"></span>
      <button class="btn ghost small" data-export="all" title="All tables plus the workload profile in one CSV (opens in Excel)">Export CSV</button>
      <button class="btn small" data-export="pptx" title="Generate a PowerPoint deck with every result on its own slide">Export PowerPoint</button>
      <span class="export-status muted small" aria-live="polite"></span>
    </div>` + filterBar(res);

    h += table('Buy servers (on-prem)', 'Purchase GPU servers and run the model yourself. One row per server model; sized in model copies (replicas), rounded to whole servers.',
      [{ label: 'Server' }, { label: 'GPU' }, { label: 'Layout' }, { label: 'Throughput basis' }, { label: 'Avg util', num: true }, ...moneyCols, { label: '' }],
      res.onprem,
      r => `<td><strong>${esc(r.name)}</strong></td><td>${esc(r.sub)}</td>
        <td>${r.feasible ? `${r.cost.nodes} node${r.cost.nodes > 1 ? 's' : ''} · ${r.cost.gpus} GPUs<br><span class="muted small">${r.sizing.best.replicas} × TP${r.sizing.best.tp}${r.sizing.best.pp > 1 ? '×PP' + r.sizing.best.pp : ''}</span>` : '—'}</td>
        <td>${r.feasible ? TC.basisLabel(r.basis) : ''}</td>${utilCell(r)}${money(r)}<td class="badges">${warnBadge(r)}${flagBadge(r)}</td>`, wl, 'onprem', keepOnprem);

    h += table('Rent GPUs (GPU cloud)', 'Rent the same GPUs from a cloud provider and run the model yourself. Reserved = committed, billed 24/7; on-demand = pay by the hour while running.',
      [{ label: 'Provider' }, { label: 'GPU / instance' }, { label: 'Pricing' }, { label: 'GPUs' }, { label: 'Avg util', num: true }, ...moneyCols, { label: '' }],
      res.cloud,
      r => `<td><strong>${esc(r.name)}</strong></td><td>${esc(r.sub)}</td><td>${esc(r.pricing)}</td>
        <td>${r.feasible ? r.cost.gpus : '—'}</td>${utilCell(r)}${money(r)}<td class="badges">${warnBadge(r)}${flagBadge(r)}</td>`, wl, 'cloud', keepCloud);

    const same = res.api.filter(r => r.sameModel);
    const closed = res.api.filter(r => !r.sameModel);
    h += table('Pay per token (API) — same model', `A provider runs ${esc(model ? model.name : '')} for you; you pay per token used. Directly comparable with buying or renting GPUs.`,
      [{ label: 'Provider' }, { label: 'Model' }, { label: 'In / out per 1M' }, ...moneyCols, { label: '' }],
      same, apiCells, wl, 'api_same', keepApi);
    if (w.include_closed_models) {
      h += table('Pay per token (API) — other models', 'Different models (GPT, Claude, Gemini…), shown for cost context only — not a like-for-like quality comparison.',
        [{ label: 'Provider' }, { label: 'Model' }, { label: 'In / out per 1M' }, ...moneyCols, { label: '' }],
        closed, apiCells, wl, 'api_closed', keepApi);
    }

    el.innerHTML = h;
  };

  function apiCells(r) {
    return `<td><strong>${esc(r.name)}</strong></td><td>${esc(r.sub)}</td>
      <td class="nowrap">${f.price(TC.v(r.price.input_per_m))} / ${f.price(TC.v(r.price.output_per_m))}</td>${money(r)}<td class="badges">${warnBadge(r)}${flagBadge(r)}</td>`;
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
      const ctl = e.target.closest('[data-view]');
      if (ctl && ctl.dataset.view === 'collapse') { view.expanded.clear(); rerender(); return; }
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
