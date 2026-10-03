/* Admin console: overview, held prices, server quotes, pending changes and publishing, worked-example checks,
   activity and settings. All reads and writes of the shared data go through TC.repo (js/admin/repo.js). */
(function () {
  const TC = window.TC, f = TC.fmt, esc = TC.esc, v = TC.v;
  const $ = s => document.querySelector(s);
  const view = $('#view');
  const PAGES = {
    overview: ['Overview', 'Health of the data behind the calculator, and what still needs attention.'],
    prices: ['Prices', 'The daily price check: what changed, what is held for review, and how each source is doing.'],
    quotes: ['Server quotes', 'Replace placeholder server prices with real quotes. Each one is queued as a pending change.'],
    pending: ['Pending changes', 'Edits waiting to be published to everyone, from this console or the calculator’s Data editor.'],
    examples: ['Worked examples', 'Re-run the seven reference patterns and check each still lands on its expected result.'],
    activity: ['Activity', 'Every change to the calculator and its data, newest first.'],
    settings: ['Settings', 'Connect this browser so it can publish changes.'],
  };
  const NAMES = ['models', 'gpus', 'servers', 'benchmarks', 'assumptions'];
  const LIST = { models: 'models', gpus: 'gpus', servers: 'servers', benchmarks: 'benchmarks' };
  const S = { status: null, me: null, page: 'overview', examples: [] };

  // ---------------------------------------------------------------- helpers
  const ago = d => {
    const s = (Date.now() - new Date(d).getTime()) / 1000;
    if (s < 90) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    const days = Math.round(s / 86400);
    return days === 1 ? 'yesterday' : days + ' days ago';
  };
  const when = d => new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  function toast(html, bad) {
    const t = document.createElement('div');
    t.className = 'toast' + (bad ? ' bad' : '');
    t.innerHTML = html;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), bad ? 9000 : 6000);
  }
  function confirmBox(title, body, okText) {
    const d = $('#confirm');
    d.querySelector('h3').textContent = title;
    d.querySelector('.confirm-body').innerHTML = body;
    d.querySelector('button[value=ok]').textContent = okText || 'Confirm';
    d.returnValue = '';
    d.showModal();
    return new Promise(res => d.addEventListener('close', () => res(d.returnValue === 'ok'), { once: true }));
  }
  const needToken = () => { if (TC.repo.signedIn()) return false; toast('Connect this browser first: <a href="#settings">Settings</a>.', true); go('settings'); return true; };
  async function busy(btn, fn) {
    const old = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Working…';
    try { return await fn(); } catch (e) { console.error(e); toast(esc(e.message), true); } finally { btn.disabled = false; btn.innerHTML = old; }
  }
  /** Remove editor bookkeeping ("original" values kept for Revert) before anything is published. */
  const clean = o => JSON.parse(JSON.stringify(o, (k, val) => (k === 'original' ? undefined : val)));

  // ---------------------------------------------------------------- data
  async function loadAll() {
    await TC.store.load();
    try { S.status = TC.repo.signedIn() ? await TC.repo.readJson('data/price-status.json') : await (await fetch('data/price-status.json', { cache: 'no-cache' })).json(); } catch (e) { S.status = null; }
    try { S.examples = (await (await fetch('data/examples.json', { cache: 'no-cache' })).json()).examples || []; } catch (e) { S.examples = []; }
    counts();
  }
  function pendingItems() {
    return NAMES.filter(n => TC.store.isOverridden(n)).map(n => ({ name: n, items: TC.store.diff(n) })).filter(x => x.items.length);
  }
  function counts() {
    const held = (S.status && (S.status.review_items || S.status.needs_review) || []).length;
    const pend = pendingItems().reduce((t, d) => t + d.items.length, 0);
    document.querySelectorAll('[data-count=held]').forEach(e => { e.textContent = held || ''; });
    document.querySelectorAll('[data-count=pending]').forEach(e => { e.textContent = pend || ''; });
  }
  function catalog() {
    const d = TC.store.all();
    const models = d.models ? d.models.models : [], gpus = d.gpus ? d.gpus.gpus : [], servers = d.servers ? d.servers.servers : [];
    const bench = d.benchmarks ? d.benchmarks.benchmarks.filter(b => typeof v(b.aggregate_output_tps) === 'number') : [];
    const apiPrices = models.reduce((t, m) => t + (m.api_prices || []).length, 0);
    const rentals = gpus.reduce((t, g) => t + (g.cloud || []).length, 0);
    const quoted = servers.filter(s => s.price_usd && s.price_usd.status !== 'placeholder').length;
    const a = d.assumptions || {};
    const ops = ['power.load_factor_pct', 'onprem.support_pct_per_year', 'onprem.net_storage_pct_of_servers'];
    const reviewed = ops.filter(p => { const [x, y] = p.split('.'); return a[x] && a[x][y] && a[x][y].status !== 'placeholder'; }).length;
    return { models, gpus, servers, bench, apiPrices, rentals, quoted, reviewed, opsTotal: ops.length };
  }

  // ---------------------------------------------------------------- pages
  const pages = {};

  pages.overview = function () {
    const st = S.status || {}, c = catalog();
    const held = (st.review_items || st.needs_review || []).length, failed = (st.sources_failed || []).length;
    const mism = (st.examples && st.examples.mismatches) || [];
    const pend = pendingItems().reduce((t, d) => t + d.items.length, 0);
    const srcs = Object.values(st.sources || {}), ok = srcs.filter(s => s.ok).length;
    const issues = held + failed + mism.length;
    const fresh = st.checked_at ? (Date.now() - new Date(st.checked_at.replace('Z', ':00Z')).getTime()) / 36e5 : null;
    const hero = `<section class="hero ${issues ? 'warn' : ''}">
      <h2>${issues ? `${issues} item${issues > 1 ? 's' : ''} need${issues > 1 ? '' : 's'} attention` : 'Everything is up to date'}</h2>
      <p>${issues ? [held && `${held} price change${held > 1 ? 's' : ''} held for review`, failed && `${failed} price source${failed > 1 ? 's' : ''} failed today`, mism.length && `${mism.length} worked example${mism.length > 1 ? 's' : ''} changed result`].filter(Boolean).join(' · ')
        : 'Prices were checked, every source answered, and every worked example still lands where it should.'}</p>
      <div class="row"><span class="chip">Last price check ${st.checked_at ? esc(ago(st.checked_at.replace('Z', ':00Z'))) : 'unknown'}</span><span class="chip">${ok}/${srcs.length} sources OK</span><span class="chip">${pend ? pend + ' pending change' + (pend > 1 ? 's' : '') : 'No pending changes'}</span></div>
    </section>`;
    const kpi = (k, val, s, page, tone) => `<div class="card kpi ${page ? 'link' : ''}" ${page ? `data-go="${page}"` : ''}><span class="k">${k}</span><span class="v" ${tone ? `style="color:var(--${tone})"` : ''}>${val}</span><span class="s">${s}</span></div>`;
    const tiles = `<div class="grid g4">
      ${kpi('Price check', st.date ? esc(new Date(st.date + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' })) : '—', `${st.values_changed || 0} value${st.values_changed === 1 ? '' : 's'} updated${fresh != null && fresh > 48 ? ' · <b style="color:var(--bad)">over 2 days old</b>' : ''}`, 'prices')}
      ${kpi('Held for review', held, held ? 'Price moves over 50% wait for a decision' : 'Nothing waiting', 'prices', held ? 'warn' : 'good')}
      ${kpi('Worked examples', `${(st.examples && st.examples.checked) || S.examples.length - mism.length}/${S.examples.length || 7}`, mism.length ? `${mism.length} changed result` : 'All land on their expected result', 'examples', mism.length ? 'bad' : 'good')}
      ${kpi('Pending changes', pend, pend ? 'Ready to publish' : 'Nothing to publish', 'pending', pend ? 'brand' : null)}
    </div>`;
    const meter = (lbl, n, total, note) => `<div class="meter"><div class="lbl"><span>${lbl}</span><b>${n} / ${total}</b></div><div class="bar"><span style="width:${total ? Math.round(n / total * 100) : 0}%"></span></div><span class="small muted">${note}</span></div>`;
    const benchGpus = new Set(c.bench.map(b => b.gpu_id)).size;
    const est = `<div class="card"><div class="card-head"><h2>What is still an estimate</h2><span class="chip ${c.quoted === c.servers.length ? 'good' : 'warn'}">Drives the confidence rating</span></div>
      ${meter('Server prices from real quotes', c.quoted, c.servers.length, c.quoted ? '' : 'Every server price is a placeholder. <a href="#quotes">Add quotes</a> for the servers that keep winning.')}
      ${meter('GPUs with a measured benchmark', benchGpus, c.gpus.length, c.bench.length ? `${c.bench.length} benchmark row${c.bench.length > 1 ? 's' : ''}` : 'No measured benchmarks yet: every server uses the theoretical speed estimate.')}
      ${meter('Operating assumptions reviewed', c.reviewed, c.opsTotal, 'Power load, support % and networking % (Data editor → Assumptions).')}
    </div>`;
    const cat = `<div class="card"><div class="card-head"><h2>Catalog</h2><a class="btn small ghost" href="index.html#data" target="_blank" rel="noopener">Open Data editor ↗</a></div>
      <div class="grid g4" style="gap:10px">
        ${[['Models', c.models.length], ['GPUs', c.gpus.length], ['Servers', c.servers.length], ['API prices', c.apiPrices], ['GPU rentals', c.rentals], ['Price sources', srcs.length]].map(([k, n]) => `<div class="kpi"><span class="k">${k}</span><span class="v" style="font-size:24px">${n}</span></div>`).join('')}
      </div></div>`;
    view.innerHTML = hero + tiles + `<div class="grid g2">${est}${cat}</div>` + `<div class="card"><div class="card-head"><h2>Recent activity</h2><a class="btn small ghost" href="#activity" data-go="activity">All activity →</a></div><div id="ov-activity"><div class="skel"></div></div></div>`;
    TC.repo.history(6).then(list => { const el = $('#ov-activity'); if (el) el.innerHTML = activityList(list); }).catch(e => { const el = $('#ov-activity'); if (el) el.innerHTML = `<p class="muted small">${esc(e.message)}</p>`; });
  };

  pages.prices = function () {
    const st = S.status || {};
    const items = st.review_items || [];
    const legacy = !items.length && (st.needs_review || []).length;
    const pct = (a, b) => (a ? Math.round((b - a) / a * 100) : 0);
    const held = items.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Price</th><th class="num">Was</th><th class="num">Now listed</th><th class="num">Change</th><th></th></tr></thead><tbody>${items.map((it, i) => {
        const d = pct(it.old, it.new);
        return `<tr><td><div class="t">${esc(it.text)}</div><div class="small muted">${esc(it.source)}</div></td><td class="num from">${esc(it.old)}</td><td class="num to">${esc(it.new)}</td><td class="num"><span class="delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${d}%</span></td>
          <td class="num"><div class="row end" style="flex-wrap:nowrap"><button class="btn small good" data-accept="${i}">Accept</button><button class="btn small bad" data-reject="${i}">Reject</button></div></td></tr>`;
      }).join('')}</tbody></table></div>
      <p class="small muted" style="margin:10px 0 0">Check the new price against the other providers for the same model. <b>Accept</b> applies it for everyone. <b>Reject</b> keeps the current price, and the same jump won’t be held again.</p>`
      : legacy ? `<div class="callout warn">${legacy} change(s) are held, from a price check that ran before this console existed. <b>Run a price check now</b> to get one-click Accept / Reject.</div><ul class="small">${st.needs_review.map(t => `<li>${esc(t)}</li>`).join('')}</ul>`
      : '<div class="empty">Nothing is held for review.</div>';
    const srcs = Object.entries(st.sources || {});
    view.innerHTML = `
      <div class="card"><div class="card-head"><h2>Held for review <span class="chip ${items.length || legacy ? 'warn' : 'good'}">${items.length || legacy || 0}</span></h2>
        <div class="row"><button class="btn primary" id="run-check">▶ Run price check now</button></div></div>${held}
        <div id="runs" class="small muted" style="margin-top:12px"></div></div>
      <div class="grid g2">
        <div class="card"><div class="card-head"><h2>Changed in the last check</h2><span class="chip info">${(st.changed || []).length}</span></div>
          ${(st.changed || []).length ? `<div class="list">${st.changed.map(t => `<div class="item"><span class="grow small">${esc(t)}</span></div>`).join('')}</div>` : '<div class="empty">No prices moved.</div>'}</div>
        <div class="card"><div class="card-head"><h2>Sources</h2><span class="chip ${srcs.every(([, s]) => s.ok) ? 'good' : 'bad'}">${srcs.filter(([, s]) => s.ok).length}/${srcs.length} OK</span></div>
          <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Source</th><th class="num">Rows</th><th class="num">Changed</th><th></th></tr></thead><tbody>
          ${srcs.map(([n, s]) => `<tr><td><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(n)}</a>${s.error ? `<div class="small" style="color:var(--bad)">${esc(s.error)}</div>` : ''}</td><td class="num">${s.rows}</td><td class="num">${s.changed}</td><td class="num"><span class="chip ${s.ok ? 'good' : 'bad'}">${s.ok ? 'OK' : 'Failed'}</span></td></tr>`).join('')}
          </tbody></table></div></div>
      </div>
      <div class="card"><div class="card-head"><h2>Updated by hand</h2><span class="chip info">${(st.manual_rows || []).length}</span></div>
        <p class="small muted" style="margin:0 0 8px">These rows have no automatic source; change them in the Data editor when the provider updates its prices.</p>
        <div class="list">${(st.manual_rows || []).map(t => `<div class="item"><span class="grow small">${esc(t)}</span></div>`).join('')}</div></div>`;
    loadRuns();
    $('#run-check').onclick = e => { if (needToken()) return; busy(e.currentTarget, async () => { await TC.repo.runPriceCheck(false); toast('Price check started. It takes 1–2 minutes; this page follows it.'); setTimeout(() => loadRuns(true), 4000); }); };
    view.querySelectorAll('[data-accept]').forEach(b => b.onclick = () => decide(items[Number(b.dataset.accept)], true, b));
    view.querySelectorAll('[data-reject]').forEach(b => b.onclick = () => decide(items[Number(b.dataset.reject)], false, b));
  };

  let runTimer = null;
  async function loadRuns(follow) {
    const el = $('#runs'); if (!el) return;
    clearTimeout(runTimer);
    try {
      const runs = await TC.repo.priceRuns(4);
      const label = r => (r.status !== 'completed' ? `<span class="chip info"><span class="spin"></span> ${esc(r.status.replace('_', ' '))}</span>` : `<span class="chip ${r.conclusion === 'success' ? 'good' : 'bad'}">${esc(r.conclusion)}</span>`);
      el.innerHTML = runs.length ? `<b>Recent runs:</b> ${runs.map(r => `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(when(r.created))}</a> ${label(r)} <span class="muted">(${r.event === 'workflow_dispatch' ? 'manual' : 'daily'})</span>`).join(' &nbsp;·&nbsp; ')}` : '';
      if (runs.some(r => r.status !== 'completed') || follow) runTimer = setTimeout(async () => {
        const again = await TC.repo.priceRuns(1).catch(() => []);
        if (again[0] && again[0].status === 'completed' && follow !== 'done') { await loadAll(); if (S.page === 'prices') pages.prices(); toast('Price check finished. Results updated.'); return; }
        loadRuns(again[0] && again[0].status === 'completed' ? false : true);
      }, 8000);
    } catch (e) { el.textContent = ''; }
  }

  async function decide(it, accept, btn) {
    if (needToken()) return;
    const ok = await confirmBox(accept ? 'Accept this price?' : 'Reject this price?',
      `<p><b>${esc(it.text)}</b></p><p>${esc(it.old)} → <b>${esc(it.new)}</b></p><p class="small">${accept ? 'The new price is applied for everyone and the calculator republishes in a minute or two.' : 'The current price stays. The daily check won’t hold this same change again.'}</p>`, accept ? 'Accept and publish' : 'Reject');
    if (!ok) return;
    await busy(btn, async () => {
      const files = [];
      const status = await TC.repo.readJson('data/price-status.json');
      const same = x => x.text === it.text && x.key === it.key && x.new === it.new;
      status.review_items = (status.review_items || []).filter(x => !same(x));
      status.needs_review = (status.needs_review || []).filter(t => !t.startsWith(it.text + ':'));
      if (accept) {
        const path = `data/${it.loc.dataset}.json`, data = await TC.repo.readJson(path);
        const rec = (data[it.loc.dataset] || []).find(r => r.id === it.loc.id);
        const row = rec && (rec[it.loc.list] || []).find(r => Object.entries(it.loc.match).every(([k, val]) => r[k] === val));
        if (!row) throw new Error('Could not find that price in the data any more; run a price check again.');
        const ks = it.key.split('.'); let p = row;
        ks.slice(0, -1).forEach(k => { p = p[k] = p[k] || {}; });
        p[ks[ks.length - 1]] = { value: it.new, source: it.source, as_of: TC.today(), status: it.status || 'estimate' };
        files.push({ path, json: data });
        status.changed = (status.changed || []).concat([`${it.text}: ${it.old} → ${it.new} (accepted in the admin console)`]);
      } else {
        const dec = await TC.repo.readJson('data/price-review-decisions.json').catch(() => ({ rejected: [] }));
        dec.rejected = (dec.rejected || []).concat([{ text: it.text, loc: it.loc, key: it.key, old: it.old, new: it.new, date: TC.today(), by: S.me ? S.me.login : '' }]);
        files.push({ path: 'data/price-review-decisions.json', json: dec });
      }
      files.push({ path: 'data/price-status.json', json: status });
      const r = await TC.repo.commit(files, `${accept ? 'Accept' : 'Reject'} held price: ${it.text} ${it.old} → ${it.new} (admin console${S.me ? ', ' + S.me.login : ''})`);
      S.status = status; counts(); pages.prices();
      toast(`${accept ? 'Accepted' : 'Rejected'}. <a href="${esc(r.url)}" target="_blank" rel="noopener">View change</a>`);
    });
  }

  pages.quotes = function () {
    const servers = (TC.store.get('servers') || { servers: [] }).servers;
    const gpus = new Map(((TC.store.get('gpus') || {}).gpus || []).map(g => [g.id, g]));
    const quoted = servers.filter(s => s.price_usd && s.price_usd.status !== 'placeholder').length;
    view.innerHTML = `<div class="card"><div class="card-head"><h2>Server prices <span class="chip ${quoted === servers.length ? 'good' : 'warn'}">${quoted}/${servers.length} quoted</span></h2>
      <input type="text" id="q-filter" placeholder="Filter by vendor, model or GPU…" style="max-width:300px"></div>
      <p class="small muted" style="margin:0 0 12px">Enter the all-in price for one server (hardware as configured, before support) and where it came from. Saving queues it under <a href="#pending">Pending changes</a>; publishing makes it the price everyone sees, and the server stops showing ⚠ placeholder.</p>
      <div class="tbl-wrap"><table class="tbl" id="q-table"><thead><tr><th>Server</th><th>GPU</th><th class="num">Current price</th><th>Status</th><th style="min-width:330px">New quote</th></tr></thead><tbody>
      ${servers.map((s, i) => { const g = gpus.get(s.gpu_id); const st = (s.price_usd && s.price_usd.status) || 'placeholder';
        return `<tr data-q="${esc((s.vendor + ' ' + s.sku + ' ' + (g ? g.name : s.gpu_id)).toLowerCase())}"><td><div class="t">${esc(s.vendor)} ${esc(s.sku)}</div><div class="small muted">${s.gpus_per_node} GPUs per server</div></td><td class="small">${esc(g ? g.name : s.gpu_id)}</td>
        <td class="num">${s.price_usd ? f.usd(v(s.price_usd)) : '—'}</td><td><span class="chip ${st === 'placeholder' ? 'warn' : 'good'}">${st === 'placeholder' ? '⚠ placeholder' : st === 'quote' ? 'quote' : esc(st)}</span>${s.price_usd && st !== 'placeholder' ? `<div class="small muted">${esc(s.price_usd.source || '')}</div>` : ''}</td>
        <td><div class="row" style="flex-wrap:nowrap"><input type="number" min="0" step="100" placeholder="USD" data-qp="${i}" style="width:120px"><input type="text" placeholder="Source, e.g. Dell quote #123, Oct 2026" data-qs="${i}"><button class="btn small primary" data-qsave="${i}">Save</button></div></td></tr>`; }).join('')}
      </tbody></table></div></div>`;
    $('#q-filter').oninput = e => { const q = e.target.value.toLowerCase(); view.querySelectorAll('#q-table tbody tr').forEach(tr => { tr.hidden = q && !tr.dataset.q.includes(q); }); };
    view.querySelectorAll('[data-qsave]').forEach(b => b.onclick = () => {
      const i = Number(b.dataset.qsave), price = Number(view.querySelector(`[data-qp="${i}"]`).value), src = view.querySelector(`[data-qs="${i}"]`).value.trim();
      if (!(price > 0)) { toast('Enter the quoted price in USD.', true); return; }
      if (!src) { toast('Add where the quote came from (vendor, reference, date).', true); return; }
      const ds = TC.clone(TC.store.get('servers')), s = ds.servers[i];
      s.price_mode = 'all_in';
      s.price_usd = { value: price, source: 'Vendor quote: ' + src, as_of: TC.today(), status: 'quote' };
      TC.store.setOverride('servers', ds); counts();
      toast(`Queued: ${esc(s.vendor)} ${esc(s.sku)} at ${f.usd(price)}. <a href="#pending">Review and publish</a>`);
      pages.quotes();
    });
  };

  pages.pending = function () {
    const groups = pendingItems();
    const total = groups.reduce((t, d) => t + d.items.length, 0);
    const LBL = { models: 'Models', gpus: 'GPUs', servers: 'Servers', benchmarks: 'Benchmarks', assumptions: 'Assumptions' };
    const fmtv = x => (x == null ? '—' : typeof x === 'number' ? f.num(x, 4) : esc(String(x)));
    view.innerHTML = !total ? `<div class="card"><div class="empty"><p style="margin:0 0 6px"><b>Nothing waiting to publish.</b></p>Save a quote under <a href="#quotes">Server quotes</a>, or edit values in the calculator’s <a href="index.html#data" target="_blank" rel="noopener">Data editor</a> in this browser; they appear here.</div></div>`
      : groups.map(g => `<div class="card"><div class="card-head"><h2>${LBL[g.name]} <span class="chip brand">${g.items.length}</span></h2><button class="btn small ghost" data-discard="${g.name}">Discard</button></div>
          <div class="list">${g.items.map(it => `<div class="item"><span class="chip ${it.kind === 'added' ? 'good' : it.kind === 'removed' ? 'bad' : 'info'}">${it.kind}</span><div class="grow"><div class="t">${esc(it.label)}</div>
            ${it.changes.map(c => `<div class="small">${esc(c.label || c.path)}: <span class="from">${fmtv(c.from)}</span> → <span class="to">${fmtv(c.to)}</span>${c.note ? ` <span class="muted">(${esc(c.note)})</span>` : ''}</div>`).join('')}</div></div>`).join('')}</div></div>`).join('')
      + `<div class="card"><div class="card-head"><h2>Publish ${total} change${total > 1 ? 's' : ''} to everyone</h2></div>
          <label class="f">Note for the history<textarea id="pub-note" placeholder="What changed and why, e.g. “Dell R760xa quote from Oct 2 call”"></textarea></label>
          <div class="row end" style="margin-top:12px"><button class="btn primary" id="publish">Publish</button></div>
          <p class="small muted" style="margin:8px 0 0">Changes are merged into the latest shared data (so today’s price updates are kept) and saved as one entry in the Activity history. The calculator updates for everyone within a few minutes.</p></div>`;
    view.querySelectorAll('[data-discard]').forEach(b => b.onclick = async () => {
      if (!(await confirmBox('Discard these edits?', `<p>Your unpublished ${LBL[b.dataset.discard].toLowerCase()} edits in this browser are removed. The shared data is not affected.</p>`, 'Discard'))) return;
      TC.store.reset(b.dataset.discard); counts(); pages.pending();
    });
    const pub = $('#publish');
    if (pub) pub.onclick = () => publish(pub);
  };

  async function publish(btn) {
    if (needToken()) return;
    const note = ($('#pub-note').value || '').trim();
    if (!note) { toast('Add a short note so the history says what changed.', true); return; }
    await busy(btn, async () => {
      const patch = TC.store.dataPatch();
      if (!patch) { toast('Nothing to publish.'); return; }
      const files = [];
      for (const n of Object.keys(patch)) {
        const latest = await TC.repo.readJson(`data/${n}.json`);  // merge onto the newest shared copy, not the one this browser loaded
        files.push({ path: `data/${n}.json`, json: clean(TC.patchDataset(n, latest, patch[n])) });
      }
      const r = await TC.repo.commit(files, `${note} (admin console${S.me ? ', ' + S.me.login : ''})`);
      Object.keys(patch).forEach(n => TC.store.reset(n));
      await loadAll(); pages.pending();
      toast(`Published. The calculator updates within a few minutes. <a href="${esc(r.url)}" target="_blank" rel="noopener">View change</a>`);
    });
  }

  pages.examples = function () {
    view.innerHTML = `<div class="card"><div class="card-head"><h2>Reference patterns</h2><button class="btn primary" id="ex-run">▶ Run all seven</button></div>
      <p class="small muted" style="margin:0 0 12px">Runs each worked example against the shared data, and again with your pending changes, so you can see whether a change would move any result before you publish it.</p>
      <div id="ex-out">${S.examples.length ? '<div class="empty">Press <b>Run all seven</b>.</div>' : '<div class="empty">Could not load the examples.</div>'}</div></div>`;
    $('#ex-run').onclick = e => busy(e.currentTarget, async () => {
      await new Promise(r => setTimeout(r, 30));
      const pub = {}, mine = TC.store.all();
      NAMES.forEach(n => { pub[n] = TC.store.defaults[n]; });
      const anyPending = NAMES.some(n => TC.store.isOverridden(n));
      const LBL = { api: 'API candidate', hybrid: 'Hybrid candidate', onprem: 'Strong on-prem candidate', 'onprem-likely': 'Likely on-prem candidate', near: 'Near breakeven', cloud: 'GPU cloud candidate' };
      const rows = S.examples.map(ex => { const a = TC.evaluateExample(ex, pub), b = anyPending ? TC.evaluateExample(ex, mine) : null; return { ex, a, b }; });
      const cell = r => `<span class="chip ${r.ok ? 'good' : 'bad'}">${r.ok ? '✓' : '✗'} ${esc(r.label)}</span>`;
      $('#ex-out').innerHTML = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Pattern</th><th>Expected</th><th>Shared data</th>${anyPending ? '<th>With your pending changes</th>' : ''}</tr></thead><tbody>
        ${rows.map(({ ex, a, b }) => `<tr><td><div class="t">${esc(ex.name)}</div><div class="small muted">${esc(ex.summary || '')}</div></td><td class="small">${esc(LBL[ex.expect] || ex.expect)}</td><td>${cell(a)}</td>${b ? `<td>${cell(b)}</td>` : ''}</tr>`).join('')}</tbody></table></div>
        <p class="small muted" style="margin:10px 0 0">${rows.every(r => r.a.ok) ? 'All seven land on their expected result.' : 'A changed result means the example (and the workshop playbook) needs updating, or a data value is wrong.'}</p>`;
    });
  };

  function activityList(list) {
    const kind = m => (/^Daily price check/.test(m) ? ['Price bot', 'info'] : /admin console/.test(m) ? ['Admin', 'brand'] : /^Bump asset|release/i.test(m) ? ['Release', 'info'] : ['Change', 'good']);
    return list.length ? `<div class="list">${list.map(c => { const [k, tone] = kind(c.message); return `<div class="item">${c.avatar ? `<img class="avatar" src="${esc(c.avatar)}" alt="">` : '<span class="avatar"></span>'}
      <div class="grow"><div class="t">${esc(c.message.split('\n')[0])}</div><div class="m">${esc(c.author)} · ${esc(when(c.date))} · <a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.sha.slice(0, 7))}</a></div></div><span class="chip ${tone}">${k}</span></div>`; }).join('')}</div>` : '<div class="empty">No activity.</div>';
  }
  pages.activity = function () {
    view.innerHTML = `<div class="card"><div class="card-head"><h2>History</h2><div class="row"><button class="btn small" data-hist="">Everything</button><button class="btn small" data-hist="data">Data only</button></div></div><div id="hist"><div class="skel"></div></div></div>`;
    const load = path => { $('#hist').innerHTML = '<div class="skel"></div>'; TC.repo.history(30, path).then(l => { $('#hist').innerHTML = activityList(l); }).catch(e => { $('#hist').innerHTML = `<p class="muted">${esc(e.message)}</p>`; }); };
    view.querySelectorAll('[data-hist]').forEach(b => b.onclick = () => load(b.dataset.hist));
    load('');
  };

  pages.settings = function () {
    const me = S.me, cfg = TC.repo.config;
    view.innerHTML = `<div class="grid g2">
      <div class="card"><div class="card-head"><h2>Connection</h2><span class="chip ${me ? 'good' : 'warn'}">${me ? 'Connected' : 'Not connected'}</span></div>
        ${me ? `<div class="item"><img class="avatar" src="${esc(me.avatar)}" alt=""><div class="grow"><div class="t">${esc(me.name)}</div><div class="m">@${esc(me.login)} · ${me.canWrite ? 'can publish' : '<b style="color:var(--bad)">read only: this token can’t publish</b>'} · ${TC.repo.remembered() ? 'remembered on this device' : 'this session only'}</div></div><button class="btn small bad" id="signout">Disconnect</button></div>`
        : `<label class="f">GitHub access token<input type="password" id="tok" placeholder="github_pat_…" autocomplete="off"></label>
           <label class="row small" style="margin-top:10px"><input type="checkbox" id="remember"> Remember on this device</label>
           <div class="row end" style="margin-top:12px"><button class="btn primary" id="connect">Connect</button></div>
           <p class="small muted">The token is kept only in this browser and sent only to GitHub. Without “remember”, it is forgotten when you close the tab.</p>`}
      </div>
      <div class="card"><h2 style="margin-bottom:10px">Create a token (2 minutes)</h2>
        <ol class="steps small">
          <li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub → Settings → Fine-grained tokens → Generate new token</a>.</li>
          <li>Name: <b>Token calculator admin</b>. Expiration: 90 days.</li>
          <li>Repository access: <b>Only select repositories</b> → <b>${esc(cfg.owner)}/${esc(cfg.repo)}</b>.</li>
          <li>Repository permissions: <b>Contents: Read and write</b> and <b>Actions: Read and write</b> (Metadata: Read is added automatically).</li>
          <li>Generate, copy the token, paste it here and press <b>Connect</b>.</li>
        </ol></div>
    </div>
    <div class="card"><h2 style="margin-bottom:8px">For IT: moving to Azure</h2>
      <p class="small" style="margin:0">Everything that reads or writes the shared data goes through one file, <span class="mono">js/admin/repo.js</span> (sign-in, read, publish as one change, history, start the price check). To move to Azure, replace it with an adapter that has the same functions: for example Azure Static Web Apps with Entra ID sign-in and a small Azure Functions API storing the data files in Blob Storage or Azure DevOps. The rest of the console, the calculator and the data files stay as they are. The daily price job (<span class="mono">scripts/update_prices.py</span>) runs unchanged as a timer-triggered function.</p></div>`;
    const c = $('#connect');
    if (c) c.onclick = () => busy(c, async () => {
      const t = $('#tok').value.trim(); if (!t) { toast('Paste the token first.', true); return; }
      TC.repo.setToken(t, $('#remember').checked);
      try { S.me = await TC.repo.whoami(); } catch (e) { TC.repo.signOut(); throw e; }
      renderWho(); await loadAll(); pages.settings();
      toast(S.me.canWrite ? `Connected as @${esc(S.me.login)}.` : 'Connected, but this token can’t publish. Check its permissions.', !S.me.canWrite);
    });
    const so = $('#signout');
    if (so) so.onclick = () => { TC.repo.signOut(); S.me = null; renderWho(); pages.settings(); toast('Disconnected. The token was removed from this browser.'); };
  };

  function renderWho() {
    const el = $('#who');
    el.innerHTML = S.me ? `<img src="${esc(S.me.avatar)}" alt=""><div><b>${esc(S.me.name)}</b><small><span class="dot on"></span> ${S.me.canWrite ? 'Can publish' : 'Read only'}</small></div>`
      : `<span class="dot"></span><div><b>Not connected</b><small><a href="#settings" style="color:inherit">Connect to publish</a></small></div>`;
  }

  // ---------------------------------------------------------------- routing
  function go(page) {
    if (!PAGES[page]) page = 'overview';
    S.page = page;
    if (location.hash.slice(1) !== page) history.replaceState(null, '', '#' + page);
    document.querySelectorAll('.nav-items a').forEach(a => a.classList.toggle('on', a.dataset.go === page));
    $('#page-title').textContent = PAGES[page][0];
    $('#page-sub').textContent = PAGES[page][1];
    pages[page]();
    window.scrollTo(0, 0);
  }
  document.addEventListener('click', e => {
    const a = e.target.closest('[data-go]');
    if (a) { e.preventDefault(); go(a.dataset.go); return; }
    const h = e.target.closest('a[href^="#"]');
    if (h && PAGES[h.getAttribute('href').slice(1)]) { e.preventDefault(); go(h.getAttribute('href').slice(1)); }
  });
  window.addEventListener('hashchange', () => go(location.hash.slice(1)));
  window.addEventListener('storage', e => { if (e.key && e.key.startsWith('tc.override.')) { counts(); if (S.page === 'pending' || S.page === 'quotes') go(S.page); } });
  TC.store.onChange(() => counts());
  $('#refresh').onclick = e => busy(e.currentTarget, async () => { await loadAll(); go(S.page); toast('Up to date.'); });

  (async function init() {
    view.innerHTML = '<div class="skel"></div><div class="grid g4"><div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div></div>';
    renderWho();
    if (TC.repo.signedIn()) { try { S.me = await TC.repo.whoami(); } catch (e) { toast(esc(e.message), true); } renderWho(); }
    await loadAll();
    go(location.hash.slice(1) || 'overview');
  })();
})();
