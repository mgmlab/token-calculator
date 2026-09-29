/* Side-by-side results tables with expandable math. */
(function () {
  const TC = window.TC;
  const f = TC.fmt;
  const esc = TC.esc;

  const view = { sort: 'name', showInfeasible: false, expanded: new Set() };
  TC.resultsView = view;

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

  function table(title, subtitle, cols, rows, cellsFn, wl, csvKey) {
    const vis = sortRows(rows).filter(r => r.feasible || view.showInfeasible);
    const hidden = rows.filter(r => !r.feasible).length;
    let h = `<section class="card result-block">
      <div class="block-head"><div><h3>${esc(title)}</h3><p class="muted">${subtitle}</p></div>
      <div class="block-actions">${hidden && !view.showInfeasible ? `<span class="muted small">${hidden} option(s) don't fit — tick "show options that don't fit"</span>` : ''}
      ${rows.length && csvKey ? `<button class="btn ghost small" data-export="${csvKey}" title="Download this table as CSV (opens in Excel)">CSV</button>` : ''}</div></div>`;
    if (!rows.length) return h + '<p class="empty">No options available for this model. Add entries in the Data editor.</p></section>';
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
    </div>`;

    h += table('On-prem (self-hosted)', 'One row per server SKU and GPU. Sized in model replicas; rounded to whole nodes.',
      [{ label: 'Server' }, { label: 'GPU' }, { label: 'Layout' }, { label: 'Throughput basis' }, ...moneyCols, { label: '' }],
      res.onprem,
      r => `<td><strong>${esc(r.name)}</strong></td><td>${esc(r.sub)}</td>
        <td>${r.feasible ? `${r.cost.nodes} node${r.cost.nodes > 1 ? 's' : ''} · ${r.cost.gpus} GPUs<br><span class="muted small">${r.sizing.best.replicas} × TP${r.sizing.best.tp}${r.sizing.best.pp > 1 ? '×PP' + r.sizing.best.pp : ''}</span>` : '—'}</td>
        <td>${r.feasible ? TC.basisLabel(r.basis) : ''}</td>${money(r)}<td class="badges">${warnBadge(r)}${flagBadge(r)}</td>`, wl, 'onprem');

    h += table('GPU cloud', 'Same replica sizing, priced per GPU-hour. Reserved is billed 24/7; on-demand uses your active hours.',
      [{ label: 'Provider' }, { label: 'GPU / instance' }, { label: 'Pricing' }, { label: 'GPUs' }, ...moneyCols, { label: '' }],
      res.cloud,
      r => `<td><strong>${esc(r.name)}</strong></td><td>${esc(r.sub)}</td><td>${esc(r.pricing)}</td>
        <td>${r.feasible ? r.cost.gpus : '—'}</td>${money(r)}<td class="badges">${warnBadge(r)}${flagBadge(r)}</td>`, wl, 'cloud');

    const same = res.api.filter(r => r.sameModel);
    const closed = res.api.filter(r => !r.sameModel);
    h += table('Public API — same model', `Hosted ${esc(model ? model.name : '')} from API providers. Directly comparable with self-hosting.`,
      [{ label: 'Provider' }, { label: 'Model' }, { label: 'In / out per 1M' }, ...moneyCols, { label: '' }],
      same, apiCells, wl, 'api_same');
    if (w.include_closed_models) {
      h += table('Public API — closed-model reference', 'Different models; shown for cost context only, not a like-for-like quality comparison.',
        [{ label: 'Provider' }, { label: 'Model' }, { label: 'In / out per 1M' }, ...moneyCols, { label: '' }],
        closed, apiCells, wl, 'api_closed');
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
      const ctl = e.target.closest('[data-view]');
      if (!ctl) return;
      if (ctl.dataset.view === 'sort') view.sort = ctl.value;
      if (ctl.dataset.view === 'showInfeasible') view.showInfeasible = ctl.checked;
      rerender();
    });
  };
})();
