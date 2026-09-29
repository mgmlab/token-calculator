/*
 * Data editor: browse and edit every dataset, saved as browser overrides,
 * with JSON import/export. Edits to a sourced value keep the original under "original".
 */
(function () {
  const TC = window.TC;
  const esc = TC.esc;

  const LIST_KEY = { models: 'models', gpus: 'gpus', servers: 'servers', benchmarks: 'benchmarks' };
  const LABELS = { models: 'Models', gpus: 'GPUs', servers: 'Servers', benchmarks: 'Benchmarks', assumptions: 'Assumptions' };
  const ENUMS = {
    status: ['estimate', 'placeholder', 'override'],
    price_mode: ['all_in', 'base_plus_gpus'],
    net_storage_mode: ['pct_of_servers', 'per_node'],
    precision: ['FP16', 'FP8', 'INT4'],
    architecture: ['dense', 'moe'],
    type: ['standard', 'hybrid_sliding', 'mla'],
  };
  const LOOKUPS = {
    gpu_id: () => ((TC.store.get('gpus') || {}).gpus || []).map(g => [g.id, g.name]),
    model_id: () => ((TC.store.get('models') || {}).models || []).filter(m => m.self_hostable).map(m => [m.id, m.name]),
    tp: () => [1, 2, 4, 8].map(n => [n, n + (n === 1 ? ' GPU' : ' GPUs') + ' per model copy']),
    pp: () => [1, 2, 4].map(n => [n, n === 1 ? '1 (single server)' : n + ' servers']),
    source_type: () => [['external', 'External / published run'], ['pellera_lab', 'Pellera lab (validated)']],
  };
  const NUMERIC_NULL = /(_per_m|_pct|_usd|_hr|_tflops_fp\d+|_tps|_kw)$/;

  const W = v => ({ value: v, source: 'User entry', as_of: TC.today(), status: 'override' });
  const TEMPLATES = {
    api_prices: () => ({ provider: '', input_per_m: W(null), output_per_m: W(null), cached_input_per_m: null, batch_discount_pct: null }),
    cloud: () => ({ provider: '', instance: '', gpus_per_instance: 8, on_demand_per_gpu_hr: W(null), reserved_per_gpu_hr: null, reserved_term: '' }),
  };

  const st = { name: 'models', sel: 0, work: null, raw: false, filter: '' };
  let saving = false;
  let pendingHeader = false;

  function recordLabel(name, r) {
    if (name === 'servers') return `${r.vendor} ${r.sku}`;
    if (name === 'benchmarks') return `${r.gpu_id} · ${r.model_id} · ${r.precision} · TP${r.tp}${r.pp > 1 ? '×PP' + r.pp : ''}`;
    return r.name || r.id || '(unnamed)';
  }
  function recordSub(name, r) {
    if (name === 'servers') return r.gpu_id + ' · ' + r.gpus_per_node + ' GPUs';
    if (name === 'models') return r.self_hostable ? 'self-hostable' : 'API only';
    if (name === 'gpus') return r.vendor;
    if (name === 'benchmarks') return (r.engine || '') + (TC.v(r.aggregate_output_tps) == null ? ' · no speed entered (ignored)' : ' · ' + TC.v(r.aggregate_output_tps) + ' tok/s');
    return '';
  }
  function countPlaceholders(o) {
    let n = 0;
    (function walk(x) {
      if (!x || typeof x !== 'object') return;
      if (TC.isWrapped(x) && x.status === 'placeholder') n++;
      Object.values(x).forEach(walk);
    })(o);
    return n;
  }

  function records() {
    const lk = LIST_KEY[st.name];
    return lk ? st.work[lk] : null;
  }
  function current() {
    const recs = records();
    return recs ? recs[st.sel] : st.work;
  }

  const tracked = new Set();
  function save() {
    if (!tracked.has(st.name)) { tracked.add(st.name); TC.track('edit-' + st.name, 'Edited ' + st.name + ' in Data editor'); }
    const first = !TC.store.isOverridden(st.name);
    saving = true;
    TC.store.setOverride(st.name, st.work);
    saving = false;
    return first;
  }

  // ---------------------------------------------------------------- form rendering
  const UNITS = { gb: 'GB', kw: 'kW', tflops: 'TFLOPS', usd: 'USD', tbps: 'TB/s', tps: 'tok/s', pct: '%', hr: 'hr', fp16: 'FP16', fp8: 'FP8', fp4: 'FP4', id: 'ID', api: 'API', kv: 'KV', pue: 'PUE', kwh: 'kWh', fte: 'FTE', tp: 'TP', pp: 'PP', gpu: 'GPU', gpus: 'GPUs', m: '1M' };
  function pretty(k) {
    const s = String(k).split('_').map(w => UNITS[w] || w).join(' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // "?" button with a plain-English definition of the field (see field-help.js).
  function help(key) {
    const k = String(key);
    if (!TC.fieldHelp || !TC.fieldHelp(st.name, k)) return '';
    return ` <button type="button" class="tip-btn" data-help-ds="${esc(st.name)}" data-help-key="${esc(k)}" data-help-label="${esc(pretty(k))}" aria-label="What is ${esc(pretty(k))}?">?</button>`;
  }
  const lab = key => `<label>${esc(pretty(key))}${help(key)}</label>`;

  function node(val, key, path) {
    const p = path.join('.');
    if (key && key[0] === '_') return `<p class="readme">${esc(val)}</p>`;
    if (TC.isWrapped(val)) {
      return `<div class="vrow" data-row="${esc(p)}">
        <label class="vlabel">${esc(pretty(key))}${help(key)}</label>
        <input class="vval" data-path="${esc(p)}.value" data-kind="wval" value="${val.value == null ? '' : esc(val.value)}" placeholder="not set">
        <select data-path="${esc(p)}.status" data-kind="str" class="st-sel st-${esc(val.status)}">${ENUMS.status.map(s => `<option ${s === val.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <input class="vsrc" data-path="${esc(p)}.source" data-kind="str" value="${esc(val.source)}" placeholder="source">
        <input class="vdate" data-path="${esc(p)}.as_of" data-kind="str" value="${esc(val.as_of)}" placeholder="as of">
        ${val.original ? `<button class="btn ghost small" data-act="revert" data-path="${esc(p)}" title="Original: ${esc(val.original.value)} (${esc(val.original.source)})">Revert</button>` : ''}
      </div>`;
    }
    if (Array.isArray(val)) {
      if (val.length && typeof val[0] !== 'object') {
        return `<div class="frow">${lab(key)}<input data-path="${esc(p)}" data-kind="list" value="${esc(val.join(', '))}"></div>`;
      }
      return `<fieldset class="arr"><legend>${esc(pretty(key))}${help(key)} <span class="muted">(${val.length})</span></legend>
        ${val.map((item, i) => `<div class="arr-item"><div class="arr-head"><strong>${esc(item.provider || item.name || item.id || '#' + (i + 1))}</strong>
          <button class="btn ghost small" data-act="rm" data-path="${esc(p)}" data-i="${i}">Remove</button></div>
          ${Object.keys(item).map(k => node(item[k], k, path.concat([i, k]))).join('')}</div>`).join('')}
        <button class="btn ghost small" data-act="add" data-path="${esc(p)}" data-key="${esc(key)}">+ Add ${esc(pretty(key).replace(/s$/, ''))}</button>
      </fieldset>`;
    }
    if (val && typeof val === 'object') {
      return `<fieldset class="obj"><legend>${esc(pretty(key))}${help(key)}</legend>${Object.keys(val).map(k => node(val[k], k, path.concat(k))).join('')}</fieldset>`;
    }
    if (val === null) {
      return `<div class="frow">${lab(key)}<span class="muted">not set</span>
        <button class="btn ghost small" data-act="setnull" data-path="${esc(p)}" data-key="${esc(key)}">Set value</button></div>`;
    }
    if (typeof val === 'boolean') {
      return `<div class="frow">${lab(key)}<input type="checkbox" data-path="${esc(p)}" data-kind="bool" ${val ? 'checked' : ''}></div>`;
    }
    const lookup = LOOKUPS[key] && LOOKUPS[key]();
    if (lookup) {
      const opts = lookup.some(o => String(o[0]) === String(val)) ? lookup : [[val, val + ' (unknown)'], ...lookup];
      const kind = typeof val === 'number' ? 'num' : 'str';
      return `<div class="frow">${lab(key)}<select data-path="${esc(p)}" data-kind="${kind}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
    }
    if (ENUMS[key] && typeof val === 'string') {
      const opts = ENUMS[key].includes(val) ? ENUMS[key] : [val, ...ENUMS[key]];
      return `<div class="frow">${lab(key)}<select data-path="${esc(p)}" data-kind="str">${opts.map(o => `<option ${o === val ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></div>`;
    }
    const kind = typeof val === 'number' ? 'num' : 'str';
    return `<div class="frow">${lab(key)}<input data-path="${esc(p)}" data-kind="${kind}" value="${esc(val)}" ${kind === 'num' ? 'inputmode="decimal"' : ''}></div>`;
  }

  function resolve(root, pathStr) {
    const parts = pathStr.split('.').map(s => (/^\d+$/.test(s) ? Number(s) : s));
    const last = parts.pop();
    let o = root;
    parts.forEach(k => { o = o[k]; });
    return { parent: o, key: last };
  }

  function parseNum(s) {
    const t = String(s).trim().replace(/[$,]/g, '');
    if (t === '') return null;
    const n = Number(t);
    return isFinite(n) ? n : s;
  }

  // ---------------------------------------------------------------- page
  function render(el) {
    if (!st.work || st.work !== st.base) {
      st.work = TC.clone(TC.store.get(st.name));
      st.base = st.work;
    }
    const recs = records();
    if (recs && st.sel >= recs.length) st.sel = Math.max(0, recs.length - 1);
    if (st.name === 'benchmarks' && recs) recs.forEach(r => { if (!('source_type' in r)) r.source_type = 'external'; });
    const src = TC.store.source[st.name];
    const ovr = TC.store.isOverridden(st.name);

    let h = `<div class="card editor">
      <div class="ed-top">
        <div class="seg">${TC.store.NAMES.map(n => `<button class="${n === st.name ? 'on' : ''}" data-ds="${n}">${LABELS[n]}${TC.store.isOverridden(n) ? ' <span class="dot" title="Has browser overrides"></span>' : ''}</button>`).join('')}</div>
        <div class="btn-row">
          <button class="btn ghost small" data-act="import">Import JSON…</button>
          <button class="btn ghost small" data-act="export">Export ${LABELS[st.name].toLowerCase()}.json</button>
          <button class="btn ghost small" data-act="bundle">Export all</button>
          <button class="btn ghost small ${ovr ? 'danger' : ''}" data-act="reset" ${ovr ? '' : 'disabled'}>Reset this dataset</button>
          ${TC.store.NAMES.some(n => TC.store.isOverridden(n)) ? '<button class="btn ghost small danger" data-act="reset-all">Clear all my changes</button>' : ''}
          <button class="btn ghost small" data-act="raw">${st.raw ? 'Form view' : 'Raw JSON'}</button>
        </div>
      </div>
      <p class="muted small">Base data: ${src === 'file' ? `loaded from <code>data/${st.name}.json</code>` : src === 'cache' ? 'last cached copy (files not reachable — see README to run locally)' : src === 'imported' ? 'imported in this browser' : 'missing'}.
        ${ovr ? '<strong>Browser overrides active</strong> — export this file and commit it to <code>/data</code> to share the change with the team.' : 'Edits are saved in this browser as overrides; the files on disk are never changed.'}
        ${countPlaceholders(st.work)} placeholder value(s) in this dataset.</p>`;

    if (st.name === 'benchmarks') {
      h += `<div class="readme bench-help"><strong>What this tab is for:</strong> record <em>measured</em> speed tests (e.g. from vLLM or TensorRT-LLM) so the calculator uses real throughput instead of its theoretical estimate.
        <ol><li>Click <strong>+ New benchmark</strong>.</li>
        <li>Pick the GPU, model, precision and TP size (GPUs per model copy) you tested.</li>
        <li>Enter the measured <strong>aggregate output tokens/sec</strong> (all requests combined) and, if you have it, tokens/sec per request, plus the engine, input/output lengths and concurrency you tested with.</li></ol>
        A row is used only when GPU, model, precision and TP match the workload exactly; on the Compare tab that row then shows <span class="badge basis-bench">measured benchmark</span>. Rows with an empty speed are ignored — the shipped Llama 3.3 row is just an example. Export benchmarks.json and commit it to share results with the team.</div>`;
    } else if (st.work._readme) h += `<p class="readme">${esc(st.work._readme)}</p>`;

    if (st.raw) {
      h += `<textarea class="raw" spellcheck="false">${esc(JSON.stringify(st.work, null, 2))}</textarea>
        <div class="btn-row"><button class="btn" data-act="apply-raw">Apply JSON</button><span class="raw-msg muted small"></span></div>`;
    } else if (recs) {
      const q = st.filter.toLowerCase();
      h += `<div class="ed-body">
        <div class="ed-list">
          <input class="search" placeholder="Filter…" value="${esc(st.filter)}" data-act="filter">
          <ul>${recs.map((r, i) => ({ r, i })).filter(({ r }) => !q || (recordLabel(st.name, r) + ' ' + recordSub(st.name, r)).toLowerCase().includes(q)).map(({ r, i }) => {
            const ph = countPlaceholders(r);
            return `<li class="${i === st.sel ? 'on' : ''}" data-sel="${i}"><span>${esc(recordLabel(st.name, r))}</span><small>${esc(recordSub(st.name, r))}${ph ? ` · ⚠ ${ph}` : ''}</small></li>`;
          }).join('')}</ul>
          <div class="btn-row">${st.name === 'benchmarks' ? '<button class="btn small" data-act="new-bench">+ New benchmark</button>' : ''}<button class="btn ghost small" data-act="dup">Duplicate</button><button class="btn ghost small danger" data-act="del">Delete</button></div>
        </div>
        <div class="ed-form">${recs.length ? Object.keys(recs[st.sel]).map(k => node(recs[st.sel][k], k, [LIST_KEY[st.name], st.sel, k])).join('') : '<p class="empty">No records.</p>'}</div>
      </div>`;
    } else {
      h += `<div class="ed-form wide">${Object.keys(st.work).filter(k => k !== '_readme').map(k => node(st.work[k], k, [k])).join('')}</div>`;
    }
    h += '</div>';
    el.innerHTML = h;
  }

  TC.editor = {
    init(el) {
      this.el = el;
      const fileIn = document.getElementById('file-import');
      TC.store.onChange(() => { if (!saving) { st.base = null; render(el); } });

      el.addEventListener('click', async e => {
        const t = e.target.closest('[data-ds],[data-sel],[data-act]');
        if (!t) return;
        if (t.dataset.ds) { st.name = t.dataset.ds; st.sel = 0; st.base = null; st.filter = ''; render(el); return; }
        if (t.dataset.sel != null && t.tagName === 'LI') { st.sel = Number(t.dataset.sel); render(el); return; }
        const act = t.dataset.act;
        const recs = records();
        if (act === 'import') fileIn.click();
        else if (act === 'export') TC.store.exportDataset(st.name);
        else if (act === 'bundle') TC.store.exportBundle();
        else if (act === 'reset') { if (confirm(`Discard browser edits to ${st.name} and go back to data/${st.name}.json?`)) { TC.store.reset(st.name); } }
        else if (act === 'reset-all') { if (confirm('Clear all your data edits (every dataset) and go back to the shared data?')) TC.store.resetAll(); }
        else if (act === 'raw') { st.raw = !st.raw; render(el); }
        else if (act === 'apply-raw') {
          const msg = el.querySelector('.raw-msg');
          try {
            const obj = JSON.parse(el.querySelector('textarea.raw').value);
            const errs = TC.store.validate(st.name, obj);
            if (errs.length) throw new Error(errs.join('; '));
            st.work = obj; st.base = obj; save(); msg.textContent = 'Applied.';
          } catch (err) { msg.textContent = 'Not applied: ' + err.message; }
        }
        else if (act === 'new-bench' && recs) {
          const W = v => ({ value: v, source: 'Measured by (name, date, link to run)', as_of: TC.today(), status: 'estimate' });
          recs.push({ gpu_id: 'h100-sxm', model_id: 'llama-3.3-70b', precision: 'FP8', tp: 2, pp: 1, engine: 'vLLM', engine_version: '',
            input_len: 1500, output_len: 400, concurrency: 32, source_type: 'external', aggregate_output_tps: W(null), per_request_output_tps: W(null) });
          st.sel = recs.length - 1; save(); render(el);
        }
        else if (act === 'dup' && recs) {
          const c = TC.clone(recs[st.sel]);
          if (c.id) c.id += '-copy';
          if (c.name) c.name += ' (copy)';
          recs.splice(st.sel + 1, 0, c); st.sel++; save(); render(el);
        }
        else if (act === 'del' && recs && recs.length) {
          if (confirm(`Delete "${recordLabel(st.name, recs[st.sel])}" from ${st.name}? (Browser override only; Reset restores it.)`)) {
            recs.splice(st.sel, 1); save(); render(el);
          }
        }
        else if (act === 'add') {
          const { parent, key } = resolve(st.work, t.dataset.path);
          const arr = parent[key];
          let item;
          if (TEMPLATES[t.dataset.key]) item = TEMPLATES[t.dataset.key]();
          else if (arr.length) {
            item = TC.clone(arr[arr.length - 1]);
            (function blank(o) { Object.keys(o).forEach(k => { if (TC.isWrapped(o[k])) o[k] = W(null); else if (o[k] && typeof o[k] === 'object') blank(o[k]); }); })(item);
          } else item = {};
          arr.push(item); save(); render(el);
        }
        else if (act === 'rm') {
          const { parent, key } = resolve(st.work, t.dataset.path);
          parent[key].splice(Number(t.dataset.i), 1); save(); render(el);
        }
        else if (act === 'setnull') {
          const { parent, key } = resolve(st.work, t.dataset.path);
          parent[key] = NUMERIC_NULL.test(t.dataset.key) ? W(null) : ''; save(); render(el);
        }
        else if (act === 'revert') {
          const { parent, key } = resolve(st.work, t.dataset.path);
          const orig = parent[key].original;
          parent[key] = orig; save(); render(el);
        }
      });

      el.addEventListener('input', e => {
        const t = e.target;
        if (t.dataset.act === 'filter') {
          st.filter = t.value;
          const pos = t.selectionStart;
          render(el);
          const s = el.querySelector('.search'); s.focus(); s.setSelectionRange(pos, pos);
          return;
        }
        if (!t.dataset.path) return;
        const { parent, key } = resolve(st.work, t.dataset.path);
        const kind = t.dataset.kind;
        if (kind === 'wval') {
          // parent is the wrapped value object
          if (parent.status !== 'override' && !parent.original && parent.value != null) { // a first-time entry has nothing to revert to
            parent.original = { value: parent.value, source: parent.source, as_of: parent.as_of, status: parent.status };
          }
          parent.value = parseNum(t.value);
          parent.status = 'override';
          parent.as_of = TC.today();
          if (parent.original) parent.source = 'User override (was ' + parent.original.value + ' from ' + (parent.original.source || 'unknown') + ')';
          const row = t.closest('.vrow');
          row.querySelector('.st-sel').value = 'override';
          row.querySelector('.st-sel').className = 'st-sel st-override';
          row.querySelector('.vsrc').value = parent.source;
          row.querySelector('.vdate').value = parent.as_of;
        } else if (kind === 'num') parent[key] = parseNum(t.value);
        else if (kind === 'bool') parent[key] = t.checked;
        else if (kind === 'list') parent[key] = t.value.split(',').map(s => s.trim()).filter(Boolean);
        else parent[key] = t.value;
        if (t.classList.contains('st-sel')) t.className = 'st-sel st-' + t.value;
        if (save()) pendingHeader = true;
      });
      // Refresh the header (override notice, tab dot) once the first edit is committed.
      el.addEventListener('change', e => { if (pendingHeader || (st.name === 'benchmarks' && e.target.dataset.path)) { pendingHeader = false; render(el); } });

      fileIn.addEventListener('change', async () => {
        const msgs = [];
        for (const file of fileIn.files) {
          try { msgs.push(await TC.store.importFile(file)); } catch (err) { msgs.push('✗ ' + err.message); }
        }
        fileIn.value = '';
        alert(msgs.join('\n'));
      });

      render(el);
    },
    render() { st.base = null; render(this.el); },

    /** Jump to a dataset, record and (optionally) field; highlights the field. */
    open(name, index, path) {
      st.name = name; st.filter = ''; st.raw = false; st.base = null;
      if (index != null) st.sel = index;
      render(this.el);
      const lk = LIST_KEY[name];
      const prefix = lk ? `${lk}.${index}.` : '';
      let target = null;
      if (path) {
        target = this.el.querySelector(`[data-path="${prefix}${path}.value"]`) || this.el.querySelector(`[data-path="${prefix}${path}"]`);
      }
      const box = target ? (target.closest('.vrow, .frow') || target) : this.el.querySelector('.ed-form');
      if (box) {
        box.scrollIntoView({ block: 'center', behavior: 'smooth' });
        box.classList.add('flash');
        setTimeout(() => box.classList.remove('flash'), 2200);
        if (target && target.focus) target.focus({ preventScroll: true });
      }
    },
  };
})();
