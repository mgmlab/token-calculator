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
  document.addEventListener('click', e => { if (ovrClose && ovrWrap && !ovrWrap.contains(e.target)) ovrClose(); });

  function statusPill() {
    const s = TC.store.source;
    const names = TC.store.NAMES;
    const fromFile = names.every(n => s[n] === 'file');
    const ovr = names.filter(n => TC.store.isOverridden(n));
    let txt = fromFile ? 'Data: /data files' : names.some(n => s[n] === 'cache') ? 'Data: cached copy' : names.some(n => s[n] === 'missing') ? 'Data: missing' : 'Data: imported';
    const pc = (TC.store.get('models') || {}).prices_checked;
    let priceTag = '';
    if (pc && pc.date) {
      const days = Math.round((Date.now() - new Date(pc.date + 'T12:00:00')) / 864e5);
      const stale = days > 14;
      const review = (pc.needs_review || []).length;
      const tip = `API prices for ${pc.rows_checked} provider rows are checked automatically every Monday against OpenRouter's public price list; last check ${pc.date} (${pc.values_changed} value(s) changed).`
        + (review ? ` ${review} change(s) over 50% are waiting for review.` : '')
        + ' GPU rental and server prices are updated by hand.';
      priceTag = `<span class="pill ${stale || review ? 'warn' : ''}" title="${TC.esc(tip)}">API prices checked ${new Date(pc.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}${review ? ' · ' + review + ' to review' : ''}</span>`;
    }
    $('#data-status').innerHTML = `<span class="pill ${fromFile ? '' : 'warn'}">${txt}</span>` + priceTag +
      (ovr.length ? `<span class="ovr-wrap"><button type="button" class="pill override" aria-expanded="false" aria-controls="ovr-pop">${ovr.length} dataset${ovr.length > 1 ? 's' : ''} overridden ▾</button>
        <div class="ovr-pop" id="ovr-pop" role="dialog" aria-label="Overridden data" hidden></div></span>` : '');
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
    const data = TC.store.all();
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
    activeTab = name;
    document.querySelectorAll('.tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    document.querySelectorAll('.tab-panel').forEach(p => { p.hidden = p.id !== 'tab-' + name; });
    try { sessionStorage.setItem('tc.tab', name); } catch (e) { /* ignore */ }
    if (name === 'data') TC.editor.render();
    compute();
  }

  function start() {
    w = TC.inputs.load();
    TC.inputs.render($('#inputs'), w, schedule);
    compute();
  }

  document.addEventListener('DOMContentLoaded', async () => {
    document.querySelectorAll('.tabs [data-tab]').forEach(b => b.onclick = () => showTab(b.dataset.tab));
    await TC.store.load();
    statusPill();
    banner();
    TC.editor.init($('#editor'));
    TC.request.init();
    TC.currentWorkload = () => Object.assign({}, w);
    TC.bindResults($('#results'), compute);

    let started = false;
    if (TC.store.ready()) { start(); started = true; }
    TC.store.onChange(() => {
      statusPill();
      banner();
      if (!TC.store.ready()) return;
      if (!started) { start(); started = true; return; }
      TC.inputs.render($('#inputs'), w, schedule);
      schedule();
    });

    let tab = 'compare';
    try { tab = sessionStorage.getItem('tc.tab') || 'compare'; } catch (e) { /* ignore */ }
    showTab(tab);
  });
})();
