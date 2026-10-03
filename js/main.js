/* App bootstrap: load data, wire tabs, recompute on change. */
(function () {
  const TC = window.TC;
  const $ = s => document.querySelector(s);
  let w = null;
  let activeTab = 'compare';
  let timer = null;

  const LABELS = { models: 'Models', gpus: 'GPUs', servers: 'Servers', benchmarks: 'Benchmarks', assumptions: 'Assumptions' };
  const show = x => (x == null || x === '' ? '—' : typeof x === 'number' ? TC.fmt.num(x, 4) : String(x));

  function overridePopover() {
    const esc = TC.esc;
    const ovr = TC.store.NAMES.filter(n => TC.store.isOverridden(n));
    return `<div class="ovr-head"><div class="ovr-head-row"><strong>Edited in this browser</strong>
        <button class="btn small danger-solid" data-reset-all>Clear all my changes</button></div>
        <span class="muted small">Saved in this browser so they survive a refresh. Only you see them. Clear them to go back to the shared data.</span></div>` +
      ovr.map(n => {
        const items = TC.store.diff(n);
        const nChanges = items.reduce((a, it) => a + Math.max(1, it.changes.length), 0);
        const list = items.slice(0, 8).map(it => {
          const go = it.index != null ? `data-goto="${n}" data-idx="${it.index}"` : `data-goto="${n}"`;
          if (it.kind === 'added') return `<li><span class="ovr-kind add">added</span> <button class="linkish" ${go}>${esc(it.label)}</button></li>`;
          if (it.kind === 'removed') return `<li><span class="ovr-kind del">removed</span> ${esc(it.label)}</li>`;
          return `<li><button class="linkish" ${go}>${esc(it.label)}</button><ul>` + it.changes.slice(0, 4).map(c =>
            `<li><button class="linkish field" ${go} data-path="${esc(c.path)}">${esc(c.label)}</button>: ${c.note ? esc(c.note) : `${esc(show(c.from))} → <strong>${esc(show(c.to))}</strong>`}</li>`).join('') +
            (it.changes.length > 4 ? `<li class="muted">and ${it.changes.length - 4} more</li>` : '') + '</ul></li>';
        }).join('');
        return `<section class="ovr-ds"><div class="ovr-ds-head"><button class="linkish strong" data-goto="${n}">${LABELS[n]}</button>
          <span class="muted small">${nChanges} change${nChanges === 1 ? '' : 's'}</span>
          <button class="btn ghost small" data-reset="${n}">Reset</button></div>
          ${items.length ? `<ul class="ovr-list">${list}${items.length > 8 ? `<li class="muted">and ${items.length - 8} more records</li>` : ''}</ul>` : '<p class="muted small">Saved as an override, but identical to the file.</p>'}</section>`;
      }).join('');
  }

  // Document-level listeners are attached once; statusPill() re-renders the pill on every data change.
  let ovrClose = null, ovrWrap = null;
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && ovrClose) ovrClose(); });
  // Close the "Load an example" menu on outside click or Escape.
  const closeExMenu = () => {
    document.querySelectorAll('.ex-menu').forEach(m => { m.hidden = true; });
    document.querySelectorAll('[data-act="examples"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
  };
  document.addEventListener('click', e => { if (!e.target.closest('.ex-wrap')) closeExMenu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeExMenu(); });
  document.addEventListener('click', e => { if (ovrClose && ovrWrap && !ovrWrap.contains(e.target)) ovrClose(); });

  function pricePopover() {
    const esc = TC.esc, ps = TC.priceStatus;
    const hold = TC.v(((TC.store.get('assumptions') || {}).rules || {}).price_hold_threshold_pct) || 50;
    const list = (title, items, cls) => items && items.length
      ? `<section class="ovr-ds"><strong>${title}</strong><ul class="ovr-list ${cls || ''}">${items.slice(0, 12).map(x => `<li>${esc(x)}</li>`).join('')}${items.length > 12 ? `<li class="muted">and ${items.length - 12} more</li>` : ''}</ul></section>` : '';
    const src = Object.entries(ps.sources || {}).map(([n, v]) =>
      `<li><span class="ovr-kind ${v.ok ? 'add' : 'del'}">${v.ok ? 'ok' : 'failed'}</span> ${esc(n)} <span class="muted">· ${v.rows} row${v.rows === 1 ? '' : 's'}${v.changed ? ` · ${v.changed} changed` : ''}</span></li>`).join('');
    return `<div class="ovr-head"><strong>Automatic price updates</strong>
        <span class="muted small">API and GPU rental prices are refreshed every day from supported public pricing sources. Last check: ${esc(new Date(ps.checked_at.replace('Z', ':00Z')).toLocaleString())}. Server and GPU purchase prices are updated by hand.</span></div>
      <section class="ovr-ds"><strong>Sources</strong><ul class="ovr-list">${src}</ul></section>
      ${list('Changed in the last check', ps.changed)}
      ${list(`Held for review (moved more than ${hold}%)`, ps.needs_review)}
      ${list('Could not be read (left unchanged)', [...(ps.sources_failed || []), ...(ps.problems || [])])}
      ${list('Manual rows (no automatic source)', ps.manual_rows)}
      ${list('Worked examples whose result changed (update data/examples.json and the workshop playbook)', ((ps.examples && ps.examples.mismatches) || []).map(m => `${m.name}: expected ${m.expected}, now ${m.got}`))}
      ${ps.needs_review && ps.needs_review.length ? '<p class="muted small">Held changes are accepted or rejected in the admin console (Prices page).</p>' : ''}`;
  }

  function wirePopover(wrap, render) {
    const btn = wrap.querySelector('button');
    const pop = wrap.querySelector('.ovr-pop');
    let pinned = false, t = null;
    const open = () => {
      clearTimeout(t); pop.innerHTML = render(); pop.hidden = false; btn.setAttribute('aria-expanded', 'true');
      pop.style.left = pop.style.right = '';
      const r = wrap.getBoundingClientRect();
      if (r.right - pop.offsetWidth < 8) { pop.style.left = (8 - r.left) + 'px'; pop.style.right = 'auto'; }
    };
    const close = () => { pinned = false; pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    wrap.addEventListener('mouseenter', () => { if (pop.hidden) open(); clearTimeout(t); });
    wrap.addEventListener('mouseleave', () => { if (!pinned) t = setTimeout(close, 300); });
    btn.addEventListener('click', () => { if (pinned) close(); else { open(); pinned = true; } });
    popClosers.push({ wrap, close: () => { if (pinned) close(); } });
  }
  const popClosers = [];
  document.addEventListener('click', e => popClosers.forEach(p => { if (document.body.contains(p.wrap) && !p.wrap.contains(e.target)) p.close(); }));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') popClosers.forEach(p => p.close()); });

  function statusPill() {
    popClosers.length = 0;
    const s = TC.store.source;
    const names = TC.store.NAMES;
    const fromFile = names.every(n => s[n] === 'file');
    const ovr = names.filter(n => TC.store.isOverridden(n));
    let txt = fromFile ? 'Shared data' : names.some(n => s[n] === 'missing') ? 'Data missing' : names.some(n => s[n] === 'cache') ? 'Offline copy' : 'Imported data';
    const ps = TC.priceStatus;
    let priceTag = '';
    if (ps && ps.date) {
      const days = Math.round((Date.now() - new Date(ps.date + 'T12:00:00')) / 864e5);
      const failed = (ps.sources_failed || []).length + (ps.problems || []).length;
      const review = (ps.needs_review || []).length;
      const exFlags = ((ps.examples && ps.examples.mismatches) || []).length;
      const warn = days > 2 || failed || review || exFlags;
      const when = days <= 0 ? 'today' : days === 1 ? 'yesterday' : new Date(ps.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      priceTag = `<span class="ovr-wrap" data-pop="prices"><button type="button" class="pill ${warn ? 'warn' : ''}" aria-expanded="false">Prices checked ${when}${review ? ' · ' + review + ' to review' : ''}${failed ? ' · ' + failed + ' issue' + (failed > 1 ? 's' : '') : ''}${exFlags ? ' · ' + exFlags + ' example' + (exFlags > 1 ? 's' : '') + ' to review' : ''} ▾</button>
        <div class="ovr-pop" role="dialog" aria-label="Price update status" hidden></div></span>`;
    }
    const tip = fromFile ? 'Numbers loaded from the shared data files everyone uses' : txt === 'Offline copy' ? 'The shared data files could not be reached; using the last copy saved in this browser, which may be out of date' : txt === 'Imported data' ? 'Using data files imported in this browser through the Data editor' : 'Some data files failed to load';
    $('#data-status').innerHTML = `<span class="pill ${fromFile ? '' : 'warn'}" title="${tip}">${txt}</span>` + priceTag +
      (ovr.length ? `<span class="ovr-wrap"><button type="button" class="pill override" aria-expanded="false" aria-controls="ovr-pop">${ovr.length} dataset${ovr.length > 1 ? 's' : ''} overridden ▾</button>
        <div class="ovr-pop" id="ovr-pop" role="dialog" aria-label="Overridden data" hidden></div></span>` : '');
    const pw = $('#data-status [data-pop="prices"]');
    if (pw) wirePopover(pw, pricePopover);
    const btn = $('#data-status .pill.override');
    if (!btn) return;
    const pop = $('#ovr-pop');
    let pinned = false, t = null;
    const open = () => {
      clearTimeout(t);
      pop.innerHTML = overridePopover();
      pop.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      // Anchor to whichever side keeps the panel on screen.
      pop.style.left = pop.style.right = '';
      const r = wrap.getBoundingClientRect();
      if (r.right - pop.offsetWidth < 8) { pop.style.left = Math.max(8 - r.left, -r.left + 8) + 'px'; pop.style.right = 'auto'; }
    };
    const close = () => { pinned = false; pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    const wrap = btn.parentElement;
    wrap.addEventListener('mouseenter', () => { if (pop.hidden) open(); clearTimeout(t); });
    wrap.addEventListener('mouseleave', () => { if (!pinned) t = setTimeout(close, 300); });
    btn.addEventListener('click', () => { if (pinned) close(); else { open(); pinned = true; } });
    ovrClose = () => { if (pinned) close(); };
    ovrWrap = wrap;
    pop.addEventListener('click', e => {
      const g = e.target.closest('[data-goto]');
      if (g) {
        close();
        showTab('data');
        TC.editor.open(g.dataset.goto, g.dataset.idx != null ? Number(g.dataset.idx) : null, g.dataset.path || null);
        return;
      }
      if (e.target.closest('[data-reset-all]')) {
        if (confirm('Clear all your data edits and go back to the shared data for everyone?')) { close(); TC.store.resetAll(); }
        return;
      }
      const r = e.target.closest('[data-reset]');
      if (r && confirm(`Discard your browser edits to ${LABELS[r.dataset.reset]} and go back to data/${r.dataset.reset}.json?`)) TC.store.reset(r.dataset.reset);
    });
  }

  function banner() {
    const b = $('#banner');
    const missing = TC.store.missing();
    const cached = TC.store.NAMES.filter(n => TC.store.source[n] === 'cache');
    if (missing.length) {
      b.hidden = false;
      b.className = 'banner error';
      b.innerHTML = `<div><strong>Data files could not be loaded</strong> (${TC.esc(missing.join(', '))}). Browsers block reading local files when the page is opened directly from disk.
        Run <code>python -m http.server 8000</code> in this folder and open <code>http://localhost:8000</code>, or import the JSON files from the <code>data</code> folder:</div>
        <button class="btn" id="banner-import">Import data files…</button>`;
      $('#banner-import').onclick = () => $('#file-import').click();
    } else if (cached.length) {
      b.hidden = false;
      b.className = 'banner';
      b.innerHTML = `<div>Using the copy of <code>/data</code> cached in this browser — the files on disk were not reachable. Run a local server (see README) to pick up file changes.</div>`;
    } else {
      b.hidden = true;
    }
  }

  function compute() {
    if (!TC.store.ready()) return;
    const data = TC.store.analysis();
    if (!data.models.models.some(m => m.id === w.model_id && m.self_hostable)) {
      const first = data.models.models.find(m => m.self_hostable);
      if (first) w.model_id = first.id;
    }
    if (activeTab === 'compare') {
      const res = TC.computeAll(data, w);
      TC.lastResults = { res, w: res.w, data };
      TC.renderResults($('#results'), res, res.w, data);
      const pk = document.getElementById('in-peak_concurrent_requests');
      if (pk && w.peak_concurrency_mode === 'derived') pk.value = res.w.peak_concurrent_requests;
    } else if (activeTab === 'breakeven') {
      TC.renderBreakeven($('#breakeven'), data, w);
    }
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(compute, 120); }

  function showTab(name) {
    if (activeTab !== name) TC.track('tab-' + name, 'Opened ' + name + ' tab');
    activeTab = name;
    if (name !== 'compare' && TC.hideBackToSummary) TC.hideBackToSummary();
    document.querySelectorAll('.tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    document.querySelectorAll('.tab-panel').forEach(p => { p.hidden = p.id !== 'tab-' + name; });
    try { sessionStorage.setItem('tc.tab', name); } catch (e) { /* ignore */ }
    if (name === 'data') TC.editor.render();
    compute();
  }

  // ---- New analysis: clear the workload (and optionally data edits) so one customer never bleeds into the next.
  const editCount = () => TC.store.NAMES.filter(n => TC.store.isOverridden(n)).length;
  function hasLeftovers() {
    const saved = TC.storage.get('tc.workload');
    const d = TC.inputs.defaults();
    const changed = saved && Object.keys(saved).some(k => JSON.stringify(saved[k]) !== JSON.stringify(d[k]));
    return !!changed || editCount() > 0 || TC.excl.count() > 0;
  }
  function startFresh(clearData, restore) {
    if (restore) TC.excl.clear();
    Object.keys(w).forEach(k => delete w[k]);
    Object.assign(w, TC.inputs.defaults());
    TC.inputs.save(w);
    $('#resume-bar').hidden = true;
    TC.track('new-analysis', clearData ? 'New analysis (cleared data edits)' : 'New analysis');
    if (clearData && editCount()) TC.store.resetAll(); // re-renders inputs via onChange
    else { TC.inputs.render($('#inputs'), w, schedule); compute(); }
  }
  // ---- Worked examples: load one (replacing inputs, removed options and data edits, like a share link).
  function applyExample(ex) {
    Object.keys(w).forEach(k => delete w[k]);
    Object.assign(w, TC.exampleWorkload(ex, TC.inputs.defaults()));
    TC.inputs.save(w);
    $('#resume-bar').hidden = true;
    TC.excl.replace(null);
    TC.store.applyDataPatch(ex.data || null); // re-renders inputs and results
    TC.inputs.render($('#inputs'), w, schedule);
    compute();
    TC.track('example-' + ex.id, 'Loaded example ' + ex.name);
  }
  TC.loadExample = function (id) {
    const ex = (TC.examples || []).find(x => x.id === id);
    if (!ex) return;
    if (!hasLeftovers() || w._example) { applyExample(ex); return; }
    const dlg = $('#new-dialog');
    dlg.innerHTML = `<form method="dialog" class="new-form">
      <h3>Load the example “${TC.esc(ex.name)}”?</h3>
      <p>This replaces your current inputs${w.scenario_name ? ` for <strong>${TC.esc(w.scenario_name)}</strong>` : ''}, removed options and Data editor changes.</p>
      <p class="muted small">Want to keep your current analysis? Cancel and use <em>Copy share link</em> first.</p>
      <div class="btn-row"><button value="cancel" class="btn ghost">Cancel</button><button value="ok" class="btn primary">Load example</button></div></form>`;
    dlg.onclose = () => { if (dlg.returnValue === 'ok') applyExample(ex); };
    dlg.returnValue = '';
    dlg.showModal();
  };
  TC.activeExample = () => (w && w._example ? (TC.examples || []).find(x => x.id === w._example) || null : null);
  TC.dismissExample = () => { delete w._example; TC.inputs.save(w); compute(); };

  TC.newAnalysis = function () {
    const dlg = $('#new-dialog');
    const n = editCount(), nx = TC.excl.count();
    dlg.innerHTML = `<form method="dialog" class="new-form">
      <h3>Start a new analysis?</h3>
      <p>This clears every workload input${w.scenario_name ? ` for <strong>${TC.esc(w.scenario_name)}</strong>` : ''} — scenario name, preset, usage, model and excluded providers — and goes back to the defaults.</p>
      ${nx ? `<label class="check"><input type="checkbox" name="restore" checked> Bring back the ${nx} option${nx > 1 ? 's' : ''} removed from this analysis</label>` : ''}
      ${n ? `<label class="check"><input type="checkbox" name="data"> Also clear my Data editor changes (${n} dataset${n > 1 ? 's' : ''} edited)</label>
      <p class="muted small">Leave this unchecked to keep prices and benchmarks you entered for use with the next customer.</p>` : ''}
      <p class="muted small">Want to keep this scenario? Cancel and use <em>Copy share link</em> or <em>Export scenario</em> first.</p>
      <div class="btn-row"><button value="cancel" class="btn ghost">Cancel</button><button value="ok" class="btn primary">Start new analysis</button></div></form>`;
    dlg.onclose = () => { if (dlg.returnValue === 'ok') startFresh(!!(dlg.querySelector('[name=data]') || {}).checked, !!(dlg.querySelector('[name=restore]') || {}).checked); };
    dlg.returnValue = '';
    dlg.showModal();
  };
  function resumeBar() {
    const b = $('#resume-bar');
    if (!hasLeftovers()) { b.hidden = true; return; }
    const n = editCount();
    const bits = [w.scenario_name ? `<strong>${TC.esc(w.scenario_name)}</strong>` : 'your last inputs'];
    if (n) bits.push(`${n} dataset${n > 1 ? 's' : ''} with Data editor changes`);
    const nx = TC.excl.count();
    if (nx) bits.push(`${nx} option${nx > 1 ? 's' : ''} removed from the analysis`);
    b.innerHTML = `<div>Continuing from last time: ${bits.join(' · ')}. Starting work for a different customer?</div>
      <div class="btn-row"><button class="btn small primary" data-rb="new">Start new analysis</button><button class="btn small ghost" data-rb="dismiss">Keep going</button></div>`;
    b.hidden = false;
    b.onclick = e => {
      const a = e.target.closest('[data-rb]');
      if (!a) return;
      if (a.dataset.rb === 'new') TC.newAnalysis(); else b.hidden = true;
    };
  }

  async function start() {
    w = TC.inputs.load();
    const shared = await TC.readShareHash();
    if (shared) {
      // A shared scenario replaces the inputs, the removed options and (for newer links) the data edits,
      // so nothing left in this browser changes the answer the sender saw.
      const sharedExcl = shared.excluded || null;
      const hasData = 'data' in shared, sharedData = shared.data || null;
      delete shared.excluded; delete shared.data;
      TC.excl.replace(sharedExcl);
      if (hasData) TC.store.applyDataPatch(sharedData);
      Object.keys(w).forEach(k => delete w[k]);
      Object.assign(w, TC.inputs.defaults(), shared);
      TC.inputs.save(w);
      history.replaceState(null, '', location.pathname + location.search);
      const b = $('#banner');
      b.hidden = false; b.className = 'banner';
      const nd = TC.store.patchSize(sharedData), nx = TC.excl.count();
      const extras = [nx ? `${nx} removed option${nx > 1 ? 's' : ''}` : '', nd ? `data edits to ${nd} dataset${nd > 1 ? 's' : ''} (prices, specs or assumptions)` : ''].filter(Boolean);
      b.innerHTML = `<div>Loaded a shared scenario${w.scenario_name ? ': <strong>' + TC.esc(w.scenario_name) + '</strong>' : ''}${extras.length ? ', including ' + extras.join(' and ') : ''}. It replaced your previous inputs${hasData ? ', removed options and data edits' : ' and removed options'}. Use <strong>New analysis</strong> or Data editor → Clear all my changes to go back to the shared data.</div>`;
      TC.track('share-link-opened', 'Opened a shared scenario');
    } else resumeBar();
    TC.inputs.render($('#inputs'), w, schedule);
    compute();
  }

  document.addEventListener('DOMContentLoaded', async () => {
    document.querySelectorAll('.tabs [data-tab]').forEach(b => b.onclick = () => showTab(b.dataset.tab));
    await TC.store.load();
    try {
      const r = await fetch('data/price-status.json', { cache: 'no-cache' });
      if (r.ok) TC.priceStatus = await r.json();
    } catch (e) { /* file:// or offline: no status pill */ }
    try {
      const r = await fetch('data/examples.json', { cache: 'no-cache' });
      if (r.ok) TC.examples = (await r.json()).examples || [];
    } catch (e) { TC.examples = []; }
    statusPill();
    banner();
    TC.editor.init($('#editor'));
    TC.request.init();
    TC.currentWorkload = () => Object.assign({}, w);
    TC.showTab = showTab;
    TC.excl.onChange(() => {
      if (!TC.store.ready()) return;
      TC.inputs.render($('#inputs'), w, schedule);
      if (activeTab === 'data') TC.editor.render();
      schedule();
    });
    TC.bindResults($('#results'), compute);

    let started = false;
    if (TC.store.ready()) { started = true; await start(); statusPill(); }
    // Links such as index.html#data (from the admin console) open the Data editor directly.
    if (location.hash === '#data' && TC.store.ready()) showTab('data');
    TC.store.onChange(() => {
      statusPill();
      banner();
      if (!TC.store.ready()) return;
      if (!started) { started = true; start(); return; }
      TC.inputs.render($('#inputs'), w, schedule);
      schedule();
    });

    let tab = 'compare';
    try { tab = sessionStorage.getItem('tc.tab') || 'compare'; } catch (e) { /* ignore */ }
    showTab(tab);
  });
})();
