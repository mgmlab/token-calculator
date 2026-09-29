/* App bootstrap: load data, wire tabs, recompute on change. */
(function () {
  const TC = window.TC;
  const $ = s => document.querySelector(s);
  let w = null;
  let activeTab = 'compare';
  let timer = null;

  function statusPill() {
    const s = TC.store.source;
    const names = TC.store.NAMES;
    const fromFile = names.every(n => s[n] === 'file');
    const ovr = names.filter(n => TC.store.isOverridden(n));
    let txt = fromFile ? 'Data: /data files' : names.some(n => s[n] === 'cache') ? 'Data: cached copy' : names.some(n => s[n] === 'missing') ? 'Data: missing' : 'Data: imported';
    $('#data-status').innerHTML = `<span class="pill ${fromFile ? '' : 'warn'}">${txt}</span>` +
      (ovr.length ? `<span class="pill override" title="${TC.esc(ovr.join(', '))}">${ovr.length} dataset${ovr.length > 1 ? 's' : ''} overridden</span>` : '');
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
