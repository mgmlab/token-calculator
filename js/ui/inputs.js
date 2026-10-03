/* Workload profile form. */
(function () {
  const TC = window.TC;
  const esc = TC.esc;
  const KEY = 'tc.workload';

  // Carry the release stamp so a new deploy of the Input guide is never served from a stale browser cache.
  const DOC = 'docs/workload-guide.html' + (((document.querySelector('script[src*="inputs.js"]') || {}).src || '').match(/\?v=\w+/) || [''])[0];

  // "What are you building?" presets — starting points only; every value can be changed.
  const PRESETS = {
    employee_copilot: { label: 'Employee copilot (chat assistant)', requests_per_user_per_day: 20, avg_input_tokens: 1500, avg_output_tokens: 400, active_days_per_month: 21.7, busy_hour_share_pct: 15, target_output_tps_per_request: 20, max_context: 32768, api_cache_hit_pct: 30, api_batch_share_pct: 0 },
    rag_search: { label: 'RAG / enterprise search', requests_per_user_per_day: 16, avg_input_tokens: 4000, avg_output_tokens: 350, active_days_per_month: 21.7, busy_hour_share_pct: 15, target_output_tps_per_request: 25, max_context: 32768, api_cache_hit_pct: 40, api_batch_share_pct: 0 },
    contact_center: { label: 'Contact center AI', requests_per_user_per_day: 60, avg_input_tokens: 2500, avg_output_tokens: 250, active_days_per_month: 30.4, busy_hour_share_pct: 10, target_output_tps_per_request: 30, max_context: 32768, api_cache_hit_pct: 50, api_batch_share_pct: 0 },
    coding_assistant: { label: 'Software development assistant', requests_per_user_per_day: 80, avg_input_tokens: 6000, avg_output_tokens: 600, active_days_per_month: 21.7, busy_hour_share_pct: 15, target_output_tps_per_request: 40, max_context: 131072, api_cache_hit_pct: 60, api_batch_share_pct: 0 },
    document_processing: { label: 'Document processing', requests_per_user_per_day: 40, avg_input_tokens: 8000, avg_output_tokens: 800, active_days_per_month: 21.7, busy_hour_share_pct: 8, target_output_tps_per_request: 10, max_context: 32768, api_cache_hit_pct: 20, api_batch_share_pct: 60 },
    ai_agents: { label: 'AI agents / automation', requests_per_user_per_day: 150, avg_input_tokens: 6000, avg_output_tokens: 500, active_days_per_month: 30.4, busy_hour_share_pct: 12, target_output_tps_per_request: 30, max_context: 131072, api_cache_hit_pct: 60, api_batch_share_pct: 0 },
    batch_inference: { label: 'Batch inference (overnight / 24×7)', requests_per_user_per_day: 200, avg_input_tokens: 2000, avg_output_tokens: 500, active_days_per_month: 30.4, busy_hour_share_pct: 4.2, target_output_tps_per_request: 10, max_context: 32768, api_cache_hit_pct: 0, api_batch_share_pct: 100 },
  };
  const PRESET_KEYS = new Set(Object.values(PRESETS).flatMap(p => Object.keys(p)).filter(k => k !== 'label'));
  TC.PRESETS = PRESETS;

  // Shown under "Advanced settings" (collapsed by default) — the essentials stay visible.
  const ADVANCED = new Set(['peak_concurrency_mode', 'busy_hour_share_pct', 'burst_percentile', 'peak_concurrent_requests', 'target_output_tps_per_request',
    'max_context', 'precision', 'kv_precision', 'kv_sizing_basis', 'throughput_source', 'headroom_pct', 'n_plus_one', 'peak_wait_s',
    'cloud_active_hours_per_month', 'api_cache_hit_pct', 'api_batch_share_pct', 'api_excluded', 'include_closed_models', 'closed_tier']);
  const ADV_KEY = 'tc.advancedOpen';

  const GROUPS = [
    { title: 'Scenario', fields: [
      { k: 'scenario_name', label: 'Scenario name (optional)', type: 'text', hint: 'Shown on exports and share links',
        tip: 'A label for this analysis. It appears on the PowerPoint and CSV exports and in shared links. It is never saved to the shared data.' },
      { k: 'preset', label: 'What are you building?', type: 'select', options: [...Object.entries(PRESETS).map(([k, p]) => [k, p.label]), ['custom', 'Custom']],
        hint: 'Illustrative starting values',
        tip: 'Fills in illustrative starting values (requests, text in and out, busy hour, speed, caching) for common AI workloads. They are not Pellera benchmarks; adjust them to the actual workload. Open Advanced settings for the technical inputs.' },
      { k: 'term_years', label: 'Comparison term', type: 'select', options: [[3, '3 years'], [5, '5 years']],
        tip: 'Comparison horizon. On-prem hardware is amortized over this term; cloud and API costs are summed over it. 3 years is common given how fast GPUs age.' },
    ]},
    { title: 'Usage', fields: [
      { k: 'users', label: 'Users', type: 'number', min: 1,
        tip: 'People who actively use the AI application in a typical month — not licensed seats or total headcount. If 400 of 1,000 employees actually use it, enter 400.' },
      { k: 'requests_per_user_per_day', label: 'Requests per user per day', type: 'number', min: 0, step: 'any',
        tip: 'Model calls per active user on an active day. One chat message = 1 request. RAG and agent workflows often make 3–10 model calls per user action — count the calls, not the clicks.' },
      { k: 'avg_input_tokens', label: 'Avg input tokens', type: 'number', min: 1,
        tip: 'Tokens sent to the model per request: system prompt + user message + retrieved documents + prior conversation. 1 token ≈ 0.75 English words (≈ 4 characters). A 2-page document is ~1,300 tokens.' },
      { k: 'avg_output_tokens', label: 'Avg output tokens', type: 'number', min: 1,
        tip: 'Tokens the model generates per request. Short chat answers 150–400; summaries 200–500; drafted emails or reports 500–1,500; code can be more. Reasoning models also generate hidden "thinking" tokens that count here.' },
      { k: 'active_days_per_month', label: 'Active days per month', type: 'number', min: 1, max: 31, step: 'any', hint: '30.4 = every day · ~21.7 = business days',
        tip: 'Days per month the workload runs. Use 21.7 for weekday-only business use, 30.4 for customer-facing or 24/7 systems.' },
    ]},
    { title: 'Performance', fields: [
      { k: 'peak_concurrency_mode', label: 'Peak concurrency', type: 'select', options: [['derived', 'Derive from traffic pattern'], ['manual', 'Enter manually']],
        tip: 'Derive (recommended): calculated from requests per day, the busy-hour share and a burst allowance, so it stays consistent with volume. Manual: enter a measured peak from a pilot or monitoring data.' },
      { k: 'busy_hour_share_pct', label: 'Busy-hour share of daily requests %', type: 'number', min: 1, max: 100, step: 'any', only: 'derived',
        tip: 'What share of a day’s requests arrive in the busiest hour. Flat 24/7 traffic = 4%. Traffic spread evenly across an 8-hour workday = 12.5%. Typical office use peaks at 15–20% (mid-morning).' },
      { k: 'burst_percentile', label: 'Burst allowance', type: 'select', options: [[95, '95th percentile'], [99, '99th percentile'], [99.9, '99.9th percentile']], only: 'derived',
        tip: 'Extra concurrency above the busy-hour average for random bursts, based on Poisson arrivals. 99th percentile means capacity is exceeded in about 1% of busy-hour moments (those requests queue briefly).' },
      { k: 'peak_concurrent_requests', label: 'Peak concurrent requests', type: 'number', min: 1,
        tip: 'The most requests being generated at the same moment during the busiest period. In derived mode this shows the calculated value. This input drives GPU count more than any other.' },
      { k: 'target_output_tps_per_request', label: 'Target output tok/s per request', type: 'number', min: 1, step: 'any',
        tip: 'How fast each user sees text stream (output tokens per second). People read ~5–10 tok/s; 20–50 feels responsive for chat. Batch or back-office jobs can accept less, which lowers cost.' },
      { k: 'max_context', label: 'Max context length', type: 'number', min: 256,
        tip: 'The longest single request (input + output tokens) the system must support, e.g. the largest document someone might paste in. Used to check that a worst-case request fits in GPU memory.' },
    ]},
    { title: 'Model', fields: [
      { k: 'model_id', label: 'Model (self-hostable)', type: 'model',
        tip: 'Open-weight model to size for self-hosting. The same model is priced from API providers that host it. Closed models (GPT, Claude, Gemini) appear only as an API reference.' },
      { k: 'precision', label: 'Weight precision', type: 'select', options: ['FP16', 'FP8', 'INT4'],
        tip: 'Number format for the model weights. FP16: full quality, 2 bytes per parameter. FP8: near-lossless on current GPUs, half the memory. INT4: smallest (0.5 byte), some quality loss, so it is worth testing on the actual use case.' },
      { k: 'kv_precision', label: 'KV-cache precision', type: 'select', options: ['FP16', 'FP8'],
        tip: 'Format of the attention cache that holds each request’s context. FP8 halves cache memory, roughly doubling how many requests fit per GPU, with minimal quality impact on modern inference engines.' },
      { k: 'kv_sizing_basis', label: 'KV sizing basis', type: 'select', options: [['typical', 'Typical (avg in + out)'], ['worst', 'Worst case (max context)']],
        tip: 'Typical: size memory for average-length requests (realistic — modern engines allocate cache as requests grow). Worst case: assume every concurrent request is at max context (very conservative, much more hardware).' },
    ]},
    { title: 'Sizing', fields: [
      { k: 'throughput_source', label: 'Throughput source', type: 'select', options: [
        ['benchmark_then_theoretical', 'Benchmark, else theoretical estimate'],
        ['benchmark_only', 'Measured benchmarks only'],
        ['theoretical_only', 'Theoretical estimate only'],
      ], tip: 'Where tokens/sec per replica comes from. Measured benchmarks (Data editor → Benchmarks) are preferred. The theoretical bandwidth-based estimate is an optimistic upper bound — fine for early sizing, not for quotes.' },
      { k: 'headroom_pct', label: 'Headroom % (growth / redundancy)', type: 'number', min: 0, step: 'any',
        tip: 'Extra capacity on top of the calculated need, for user growth, traffic bursts and maintenance windows. 20–30% is typical.' },
      { k: 'n_plus_one', label: 'Add one spare server (N+1)', type: 'checkbox',
        tip: 'Adds one whole spare server to every on-prem and hybrid configuration, so a server failure or maintenance window never drops capacity below the need. Typical for business-critical services. The spare is costed but not counted as serving capacity.' },
      { k: 'peak_wait_s', label: 'Acceptable wait in the busiest hour', type: 'select', options: [[0, 'No waiting: size for the full peak'], [5, 'Up to 5 seconds'], [30, 'Up to 30 seconds'], [120, 'Up to 2 minutes'], [600, 'Up to 10 minutes (background work)']],
        tip: 'How long a request may wait to start during the busiest hour. Allowing a short wait lets fewer servers cover the workload: requests beyond capacity queue for a moment instead of buying servers for the busiest minutes. Measured as 95% of busiest-hour requests starting within this time. Interactive chat: no waiting or 5 s. Internal tools: up to 30 s. Agents and background jobs: minutes.' },
    ]},
    { title: 'Cloud & API', fields: [
      { k: 'cloud_active_hours_per_month', label: 'On-demand active hours / month', type: 'number', min: 1, max: 744,
        tip: 'Hours per month on-demand cloud GPUs run. 730 = always on. If capacity is shut down outside business hours: 12 h × 21.7 days ≈ 260. Reserved capacity is always billed 730 h.' },
      { k: 'api_cache_hit_pct', label: 'API cached-input share %', type: 'number', min: 0, max: 100, step: 'any',
        tip: 'Share of input tokens the API provider serves from its prompt cache — repeated system prompts, tool definitions or documents reused across requests. Cached input is billed at a steep discount (often 90%).' },
      { k: 'api_batch_share_pct', label: 'API batch share %', type: 'number', min: 0, max: 100, step: 'any',
        tip: 'Share of traffic that can wait (up to ~24 h) for asynchronous batch pricing, usually 50% off. Interactive chat = 0%; overnight document processing could be 100%.' },
      { k: 'api_excluded', label: 'API providers to compare', type: 'providers',
        tip: 'Untick providers your customer would not realistically buy from — for example the lowest-cost routed hosts when the customer needs an enterprise agreement. Unticked providers are left out of the tables, the Analysis summary, breakeven and hybrid.' },
      { k: 'include_closed_models', label: 'Show closed-model API reference', type: 'checkbox',
        tip: 'Also list closed models (GPT, Claude, Gemini, DeepSeek API) for cost context. They are different models, so this is not a like-for-like quality comparison.' },
      { k: 'closed_tier', label: 'Closed-model tier', type: 'select', options: [['all', 'All tiers (cheapest wins)'], ['budget', 'Budget (mini / Flash / Haiku)'], ['mid', 'Mid (Sonnet-class)'], ['frontier', 'Frontier (flagship)']],
        tip: 'Closed models range from small budget models to flagship frontier models, and prices differ several-fold. "All tiers" shows the cheapest closed model, which is usually a budget model. Pick Frontier when the customer is really comparing against a flagship model such as GPT, Claude Opus or Gemini Pro. Tiers follow each vendor’s own positioning and can be changed in the Data editor.' },
    ]},
  ];

  // ---- Tooltips: one floating element positioned next to the "?" button (position: fixed,
  // so the scrolling inputs panel never clips it). Hover/focus shows it; click pins it (touch).
  const FIELDS = {};
  GROUPS.forEach(g => g.fields.forEach(fd => { FIELDS[fd.k] = fd; }));
  let tipEl = null, pinned = null, hideTimer = null;
  /** Scrolls to a Workload profile input (opening Advanced settings if needed) and highlights it; "@ds:path" opens the Data editor. */
  TC.gotoField = function (key) {
    if (key.charAt(0) === '@') {
      const [ds, path] = key.slice(1).split(':');
      TC.showTab('data');
      TC.editor.open(ds, null, path);
      return;
    }
    TC.showTab('compare');
    const f = document.querySelector(`.inputs [data-field="${key}"]`);
    if (!f) return;
    const adv = f.closest('details');
    if (adv && !adv.open) adv.open = true;
    f.scrollIntoView({ behavior: 'smooth', block: 'center' });
    f.classList.remove('field-flash'); void f.offsetWidth; f.classList.add('field-flash');
    const ctl = f.querySelector('input:not([type=checkbox]), select') || f.querySelector('input');
    if (ctl) setTimeout(() => ctl.focus({ preventScroll: true }), 350);
  };
  TC.inputTip = k => (FIELDS[k] ? FIELDS[k].tip : null);
  function tipShow(btn) {
    // Data editor fields carry data-help-key; workload inputs carry data-tip.
    const fd = btn.dataset.helpKey
      ? { label: btn.dataset.helpLabel || btn.dataset.helpKey, tip: TC.fieldHelp(btn.dataset.helpDs, btn.dataset.helpKey), noDoc: true }
      : FIELDS[btn.dataset.tip];
    if (!fd || !fd.tip) return;
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'field-tip';
      tipEl.setAttribute('role', 'tooltip');
      tipEl.id = 'field-tip';
      tipEl.addEventListener('mouseenter', () => clearTimeout(hideTimer));
      tipEl.addEventListener('mouseleave', () => { if (!pinned) hideTimer = setTimeout(tipHide, 200); });
      document.body.appendChild(tipEl);
    }
    clearTimeout(hideTimer);
    tipEl.innerHTML = `<strong>${esc(fd.label)}</strong><p>${esc(fd.tip)}</p>` + (fd.noDoc ? '' : `<a href="${DOC}#${esc(fd.k)}" target="_blank" rel="noopener">How to estimate this for a client ↗</a>`);
    tipEl.hidden = false;
    document.querySelectorAll('.tip-btn[aria-describedby]').forEach(b => { if (b !== btn) b.removeAttribute('aria-describedby'); });
    btn.setAttribute('aria-describedby', 'field-tip');
    const r = btn.getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 24);
    tipEl.style.width = w + 'px';
    let left = r.right + 10;
    let top = r.top - 8;
    if (left + w > window.innerWidth - 12) { left = Math.max(12, window.innerWidth - w - 12); top = r.bottom + 8; }
    tipEl.style.left = left + 'px';
    tipEl.style.top = Math.max(12, Math.min(top, window.innerHeight - tipEl.offsetHeight - 12)) + 'px';
  }
  function tipHide() {
    if (tipEl) tipEl.hidden = true;
    // Clear the open-tip marker so the ? stops looking highlighted once its tip is closed.
    document.querySelectorAll('.tip-btn[aria-describedby]').forEach(b => b.removeAttribute('aria-describedby'));
    pinned = null;
  }
  document.addEventListener('mouseover', e => {
    const b = e.target.closest && e.target.closest('.tip-btn');
    if (b && !pinned) tipShow(b);
  });
  document.addEventListener('mouseout', e => {
    const b = e.target.closest && e.target.closest('.tip-btn');
    if (b && !pinned) hideTimer = setTimeout(tipHide, 250);
  });
  document.addEventListener('focusin', e => { if (e.target.classList && e.target.classList.contains('tip-btn')) tipShow(e.target); });
  document.addEventListener('focusout', e => {
    if (e.target.classList && e.target.classList.contains('tip-btn') && !pinned && !(e.relatedTarget && e.relatedTarget.closest('.field-tip'))) hideTimer = setTimeout(tipHide, 250);
  });
  document.addEventListener('click', e => {
    const b = e.target.closest('.tip-btn');
    if (b) { if (pinned === b) tipHide(); else { tipShow(b); pinned = b; } return; }
    if (pinned && !e.target.closest('.field-tip')) tipHide();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') tipHide(); });
  window.addEventListener('scroll', e => { if (tipEl && !tipEl.hidden && !(e.target.closest && e.target.closest('.field-tip'))) tipHide(); }, true);

  let advIsOpen = false; // open state survives re-renders, not page refreshes
  function advOpen() { return advIsOpen; }

  // Share links carry the inputs in the #hash, which browsers never send to the server or analytics.
  // A link is a complete snapshot: workload inputs, removed options and this browser's data edits (as changes
  // against the shared files), compressed. Opening it replaces all three in the viewer's browser.
  const b64u = bytes => { let s = ''; bytes.forEach(b => { s += String.fromCharCode(b); }); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const unb64u = str => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  async function pipe(bytes, stream) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer()); }
  TC.sharePayload = w => {
    const payload = Object.fromEntries(Object.entries(w).filter(([k]) => !k.startsWith('_') && k !== 'excluded' && k !== 'data'));
    payload.excluded = TC.excl.count() ? TC.excl.get() : null;
    payload.data = TC.store.dataPatch();
    return payload;
  };
  TC.shareUrl = async w => {
    const json = new TextEncoder().encode(JSON.stringify(TC.sharePayload(w)));
    const base = location.origin + location.pathname;
    if (typeof CompressionStream === 'function') return base + '#z=' + b64u(await pipe(json, new CompressionStream('deflate-raw')));
    return base + '#s=' + b64u(json);
  };
  /** Returns the shared scenario in the URL (new #z= or older #s= links), or null. */
  TC.readShareHash = async () => {
    try {
      const z = /[#&]z=([A-Za-z0-9_-]+)/.exec(location.hash);
      if (z) return JSON.parse(new TextDecoder().decode(await pipe(unb64u(z[1]), new DecompressionStream('deflate-raw'))));
    } catch (e) { return null; }
    const m = /[#&]s=([A-Za-z0-9_-]+)/.exec(location.hash);
    if (!m) return null;
    try {
      const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(escape(atob(b64))));
    } catch (e) { return null; }
  };

  TC.inputs = {
    defaults() {
      const a = TC.store.get('assumptions');
      const d = TC.clone((a && a.workload_defaults) || {});
      delete d._note;
      return d;
    },
    load() {
      return Object.assign(this.defaults(), TC.storage.get(KEY) || {});
    },
    save(w) { TC.storage.set(KEY, w); },

    render(el, w, onChange) {
      const models = (TC.store.analysis().models || { models: [] }).models.filter(m => m.self_hostable);
      const tipBtn = fd => fd.tip
        ? `<button type="button" class="tip-btn" data-tip="${esc(fd.k)}" aria-label="What is ${esc(fd.label)}?">?</button>`
        : '';
      const field = fd => {
        const id = 'in-' + fd.k;
        const val = w[fd.k];
        let ctl;
        if (fd.type === 'checkbox') {
          return `<div class="field check" data-field="${fd.k}"><input type="checkbox" id="${id}" data-k="${fd.k}" ${val ? 'checked' : ''}><label for="${id}">${esc(fd.label)}</label>${tipBtn(fd)}</div>`;
        }
        if (fd.type === 'providers') {
          const md = (TC.store.get('models') || { models: [] }).models;
          const provs = [...new Set(md.flatMap(m => (m.api_prices || []).map(p => p.provider)))].sort((a, b) => a.localeCompare(b));
          const ex = new Set(val || []);
          return `<div class="field" data-field="${fd.k}"><div class="field-label"><label>${esc(fd.label)}</label>${tipBtn(fd)}</div>
            <div class="prov-list">${provs.map(p => `<label class="check"><input type="checkbox" data-provider="${esc(p)}" ${ex.has(p) ? '' : 'checked'}> ${esc(p)}</label>`).join('')}</div>
            <small>${ex.size ? `${ex.size} excluded · <button type="button" class="linkish" data-act="prov-all">include all</button>` : 'All providers included'}</small></div>`;
        }
        if (fd.type === 'model') {
          // Grouped by maker (alphabetical, vendor-neutral), smallest model first within each group.
          const size = m => TC.v(m.params_total_b) || 0;
          const fam = m => (m.family || 'Other').replace(/ open-weight$/, ' (open-weight)');
          const groups = {};
          models.slice().sort((a, b) => fam(a).localeCompare(fam(b)) || size(a) - size(b) || a.name.localeCompare(b.name))
            .forEach(m => { (groups[fam(m)] = groups[fam(m)] || []).push(m); });
          ctl = `<select id="${id}" data-k="${fd.k}">` + Object.entries(groups).map(([g, ms]) => `<optgroup label="${esc(g)}">` +
            ms.map(m => `<option value="${esc(m.id)}" ${m.id === val ? 'selected' : ''}>${esc(m.name)}</option>`).join('') + '</optgroup>').join('') + '</select>';
        } else if (fd.type === 'select') {
          ctl = `<select id="${id}" data-k="${fd.k}" ${typeof fd.options[0] === 'object' && typeof fd.options[0][0] === 'number' ? 'data-num="1"' : ''}>` + fd.options.map(o => {
            const [ov, ol] = Array.isArray(o) ? o : [o, o];
            return `<option value="${esc(ov)}" ${String(ov) === String(val) ? 'selected' : ''}>${esc(ol)}</option>`;
          }).join('') + '</select>';
        } else if (fd.type === 'text') {
          ctl = `<input type="text" id="${id}" data-k="${fd.k}" value="${esc(val || '')}" maxlength="80" autocomplete="off">`;
        } else {
          const locked = fd.k === 'peak_concurrent_requests' && w.peak_concurrency_mode === 'derived';
          ctl = `<input type="number" id="${id}" data-k="${fd.k}" value="${esc(val)}" ${fd.min != null ? `min="${fd.min}"` : ''} ${fd.max != null ? `max="${fd.max}"` : ''} step="${fd.step || 1}" ${locked ? 'readonly class="derived" title="Calculated from the traffic pattern — switch Peak concurrency to manual to edit"' : ''}>`;
        }
        if (fd.only && w.peak_concurrency_mode !== fd.only) return '';
        return `<div class="field" data-field="${fd.k}"><div class="field-label"><label for="${id}">${esc(fd.label)}</label>${tipBtn(fd)}</div>${ctl}${fd.hint ? `<small>${esc(fd.hint)}</small>` : ''}</div>`;
      };

      el.innerHTML = `<form class="inputs-form" onsubmit="return false">
        <div class="inputs-head"><h2>Workload profile</h2>
          <div class="seg-bar" role="toolbar" aria-label="Workload actions">
            <button type="button" class="seg-btn" data-act="new" title="Clear these inputs and start a fresh analysis">New analysis</button>
            ${(TC.examples || []).length ? `<span class="ex-wrap"><button type="button" class="seg-btn" data-act="examples" aria-expanded="false" title="Load a worked example">Examples<span class="seg-caret" aria-hidden="true"></span></button>
              <div class="ex-menu" role="menu" hidden><p class="muted small">Worked examples that each lead to a different result. Loading one replaces the current inputs.</p>
              ${TC.examples.map(x => `<button type="button" role="menuitem" class="ex-item" data-ex="${esc(x.id)}"><strong>${esc(x.name)}</strong><span>${esc(x.summary)}</span></button>`).join('')}</div></span>` : ''}
            <a class="seg-btn" href="${DOC}" target="_blank" rel="noopener" title="How to gather these inputs from a client">Input guide<span class="seg-ext" aria-hidden="true">↗</span></a>
          </div></div>
        ${GROUPS.map(g => { const fs = g.fields.filter(fd => !ADVANCED.has(fd.k)); return fs.length ? `<fieldset><legend>${esc(g.title)}</legend>${fs.map(field).join('')}</fieldset>` : ''; }).join('')}
        <details class="adv-settings" ${advOpen() ? 'open' : ''}><summary>Advanced settings</summary>
        ${GROUPS.map(g => { const fs = g.fields.filter(fd => ADVANCED.has(fd.k)); return fs.length ? `<fieldset><legend>${esc(g.title)}</legend>${fs.map(field).join('')}</fieldset>` : ''; }).join('')}
        </details>
        <div class="btn-row">
          <button type="button" class="btn ghost" data-act="export">Export scenario</button>
          <button type="button" class="btn ghost" data-act="import">Import scenario</button>
          <button type="button" class="btn ghost" data-act="share" title="Copy a link that opens the calculator with everything in this analysis">Copy share link</button>
        </div>
        <p class="share-msg muted small" hidden></p>
        <input type="file" accept=".json" hidden data-act="file"></form>`;
      const form = el.firstElementChild;
      form.querySelector('.adv-settings').addEventListener('toggle', e => { advIsOpen = e.target.open; });
      try { localStorage.removeItem(ADV_KEY); } catch (x) { /* clear the old saved state */ }

      form.addEventListener('click', e => {
        const exBtn = e.target.closest('[data-act="examples"]');
        const menu = form.querySelector('.ex-menu');
        if (exBtn && menu) { const open = menu.hidden; menu.hidden = !open; exBtn.setAttribute('aria-expanded', String(open)); return; }
        const item = e.target.closest('[data-ex]');
        if (item) { menu.hidden = true; form.querySelector('[data-act="examples"]').setAttribute('aria-expanded', 'false'); TC.loadExample(item.dataset.ex); return; }
        if (e.target.closest('[data-act="prov-all"]')) { w.api_excluded = []; this.save(w); this.render(el, w, onChange); onChange(); }
      });
      form.addEventListener('input', e => {
        const t = e.target;
        if (t.dataset.provider) {
          const ex = new Set(w.api_excluded || []);
          if (t.checked) ex.delete(t.dataset.provider); else ex.add(t.dataset.provider);
          w.api_excluded = [...ex];
          this.save(w);
          TC.track('api-provider-filter', 'Changed API providers');
          this.render(el, w, onChange);
          onChange();
          return;
        }
        if (!t.dataset.k) return;
        if (t.type === 'file' || t.readOnly) return;
        let val;
        if (t.type === 'checkbox') val = t.checked;
        else if (t.type === 'number' || t.dataset.num) { val = parseFloat(t.value); if (!isFinite(val)) return; }
        else val = t.value;
        if (t.dataset.k === 'preset') {
          w.preset = val;
          if (PRESETS[val]) { Object.entries(PRESETS[val]).forEach(([k, x]) => { if (k !== 'label') w[k] = x; }); TC.track('preset-' + val, 'Preset ' + val); }
          this.save(w);
          this.render(el, w, onChange);
          onChange();
          return;
        }
        w[t.dataset.k] = val;
        if (PRESET_KEYS.has(t.dataset.k) && w.preset !== 'custom') {
          w.preset = 'custom';
          const ps = form.querySelector('[data-k="preset"]'); if (ps) ps.value = 'custom';
        }
        if (t.dataset.k === 'model_id') TC.track('model-' + val, 'Compared model ' + val);
        this.save(w);
        if (t.dataset.k === 'peak_concurrency_mode') this.render(el, w, onChange);
        onChange();
      });

      const fileIn = el.querySelector('[data-act="file"]');
      el.querySelector('[data-act="new"]').onclick = () => TC.newAnalysis();
      el.querySelector('[data-act="share"]').onclick = async () => {
        const url = await TC.shareUrl(w);
        const m = form.querySelector('.share-msg');
        const nx = TC.excl.count(), nd = TC.store.patchSize(TC.store.dataPatch());
        const btn = el.querySelector('[data-act="share"]');
        try {
          await navigator.clipboard.writeText(url);
          // Confirm on the button itself, where the user is looking, then restore it.
          btn.textContent = '✓ Link copied';
          btn.classList.add('copied');
          clearTimeout(btn._t);
          btn._t = setTimeout(() => { btn.textContent = 'Copy share link'; btn.classList.remove('copied'); }, 2500);
          const parts = ['these exact inputs'];
          if (nx) parts.push(`the ${nx} removed option${nx > 1 ? 's' : ''}`);
          if (nd) parts.push(`your Data editor changes (${nd} dataset${nd > 1 ? 's' : ''})`);
          m.innerHTML = TC.esc('Anyone who opens it sees ' + parts.join(', ').replace(/, ([^,]*)$/, ' and $1') + '.')
            + (nd ? ' <strong>The link includes your edited prices and specs, so share it only with people who should see them.</strong>' : '');
        } catch (e) {
          // Clipboard blocked: show the link, selected, so it can be copied by hand.
          m.innerHTML = 'Your browser blocked copying. Press Ctrl+C to copy this link:<input type="text" class="share-url" readonly>';
          const box = m.querySelector('.share-url');
          box.value = url;
          setTimeout(() => { box.focus(); box.select(); }, 0);
        }
        m.insertAdjacentHTML('afterbegin', '<button type="button" class="share-x" aria-label="Hide this message">×</button>');
        m.querySelector('.share-x').onclick = () => { m.hidden = true; };
        m.hidden = false;
        TC.track('share-link', 'Copied share link');
      };
      el.querySelector('[data-act="export"]').onclick = () => TC.download('scenario-' + TC.today() + '.json', { tc_scenario: 1, workload: w, excluded: TC.excl.get() });
      el.querySelector('[data-act="import"]').onclick = () => fileIn.click();
      fileIn.onchange = async () => {
        const file = fileIn.files[0];
        if (!file) return;
        try {
          const obj = JSON.parse(await file.text());
          const wk = Object.assign({}, obj.workload || obj);
          delete wk.excluded;
          Object.assign(w, wk);
          if (obj.tc_scenario) TC.excl.replace(obj.excluded || null); // a scenario file sets exactly what is removed
          this.save(w);
          this.render(el, w, onChange);
          onChange();
        } catch (e) { alert('Could not import scenario: ' + e.message); }
      };
    },
  };
})();
