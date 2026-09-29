/* Workload profile form. */
(function () {
  const TC = window.TC;
  const esc = TC.esc;
  const KEY = 'tc.workload';

  const DOC = 'docs/workload-guide.html';
  const GROUPS = [
    { title: 'Usage', fields: [
      { k: 'users', label: 'Users', type: 'number', min: 1,
        tip: 'People who actively use the AI application in a typical month — not licensed seats or total headcount. If 400 of 1,000 employees actually use it, enter 400.' },
      { k: 'requests_per_user_per_day', label: 'Requests per user per day', type: 'number', min: 0, step: 'any',
        tip: 'Model calls per active user on an active day. One chat message = 1 request. RAG and agent workflows often make 3–10 model calls per user action — count the calls, not the clicks.' },
      { k: 'avg_input_tokens', label: 'Avg input tokens', type: 'number', min: 1, hint: 'Prompt + retrieved context + chat history',
        tip: 'Tokens sent to the model per request: system prompt + user message + retrieved documents + prior conversation. 1 token ≈ 0.75 English words (≈ 4 characters). A 2-page document is ~1,300 tokens.' },
      { k: 'avg_output_tokens', label: 'Avg output tokens', type: 'number', min: 1,
        tip: 'Tokens the model generates per request. Short chat answers 150–400; summaries 200–500; drafted emails or reports 500–1,500; code can be more. Reasoning models also generate hidden "thinking" tokens that count here.' },
      { k: 'active_days_per_month', label: 'Active days per month', type: 'number', min: 1, max: 31, step: 'any', hint: '30.4 = every day · ~21.7 = business days',
        tip: 'Days per month the workload runs. Use 21.7 for weekday-only business use, 30.4 for customer-facing or 24/7 systems.' },
    ]},
    { title: 'Performance', fields: [
      { k: 'peak_concurrency_mode', label: 'Peak concurrency', type: 'select', options: [['derived', 'Derive from traffic pattern'], ['manual', 'Enter manually']],
        tip: 'Derive (recommended): calculated from requests per day, the busy-hour share and a burst allowance, so it stays consistent with volume. Manual: enter a measured peak from a pilot or monitoring data.' },
      { k: 'busy_hour_share_pct', label: 'Busy-hour share of daily requests %', type: 'number', min: 1, max: 100, step: 'any', only: 'derived', hint: '4% = flat 24/7 · 12.5% = even over 8 h · 15–20% = typical workday peak',
        tip: 'What share of a day’s requests arrive in the busiest hour. Flat 24/7 traffic = 4%. Traffic spread evenly across an 8-hour workday = 12.5%. Typical office use peaks at 15–20% (mid-morning).' },
      { k: 'burst_percentile', label: 'Burst allowance', type: 'select', options: [[95, '95th percentile'], [99, '99th percentile'], [99.9, '99.9th percentile']], only: 'derived',
        tip: 'Extra concurrency above the busy-hour average for random bursts, based on Poisson arrivals. 99th percentile means capacity is exceeded in about 1% of busy-hour moments (those requests queue briefly).' },
      { k: 'peak_concurrent_requests', label: 'Peak concurrent requests', type: 'number', min: 1,
        tip: 'The most requests being generated at the same moment during the busiest period. In derived mode this shows the calculated value. This input drives GPU count more than any other.' },
      { k: 'target_output_tps_per_request', label: 'Target output tok/s per request', type: 'number', min: 1, step: 'any', hint: 'Reading speed is roughly 5–10 tok/s; chat UIs often target 20–50',
        tip: 'How fast each user sees text stream (output tokens per second). People read ~5–10 tok/s; 20–50 feels responsive for chat. Batch or back-office jobs can accept less, which lowers cost.' },
      { k: 'max_context', label: 'Max context length', type: 'number', min: 256,
        tip: 'The longest single request (input + output tokens) the system must support, e.g. the largest document someone might paste in. Used to check that a worst-case request fits in GPU memory.' },
    ]},
    { title: 'Model', fields: [
      { k: 'model_id', label: 'Model (self-hostable)', type: 'model',
        tip: 'Open-weight model to size for self-hosting. The same model is priced from API providers that host it. Closed models (GPT, Claude, Gemini) appear only as an API reference.' },
      { k: 'precision', label: 'Weight precision', type: 'select', options: ['FP16', 'FP8', 'INT4'],
        tip: 'Number format for the model weights. FP16: full quality, 2 bytes per parameter. FP8: near-lossless on current GPUs, half the memory. INT4: smallest (0.5 byte), some quality loss — validate on the client’s tasks.' },
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
      { k: 'n_plus_one', label: 'Add one spare replica (N+1)', type: 'checkbox',
        tip: 'Adds one extra model replica so a GPU or node failure (or a rolling upgrade) never drops capacity below peak.' },
      { k: 'term_years', label: 'Term (years)', type: 'select', options: [[3, '3 years'], [5, '5 years']],
        tip: 'Comparison horizon. On-prem hardware is amortized over this term; cloud and API costs are summed over it. 3 years is common given how fast GPUs age.' },
    ]},
    { title: 'Cloud & API', fields: [
      { k: 'cloud_active_hours_per_month', label: 'On-demand active hours / month', type: 'number', min: 1, max: 744, hint: '730 = 24/7 · 12 h × 21.7 days ≈ 260',
        tip: 'Hours per month on-demand cloud GPUs run. 730 = always on. If capacity is shut down outside business hours: 12 h × 21.7 days ≈ 260. Reserved capacity is always billed 730 h.' },
      { k: 'api_cache_hit_pct', label: 'API cached-input share %', type: 'number', min: 0, max: 100, step: 'any',
        tip: 'Share of input tokens the API provider serves from its prompt cache — repeated system prompts, tool definitions or documents reused across requests. Cached input is billed at a steep discount (often 90%).' },
      { k: 'api_batch_share_pct', label: 'API batch share %', type: 'number', min: 0, max: 100, step: 'any', hint: 'Share of traffic that can wait for async batch pricing',
        tip: 'Share of traffic that can wait (up to ~24 h) for asynchronous batch pricing, usually 50% off. Interactive chat = 0%; overnight document processing could be 100%.' },
      { k: 'include_closed_models', label: 'Show closed-model API reference', type: 'checkbox',
        tip: 'Also list closed models (GPT, Claude, Gemini, DeepSeek API) for cost context. They are different models, so this is not a like-for-like quality comparison.' },
    ]},
  ];

  // ---- Tooltips: one floating element positioned next to the "?" button (position: fixed,
  // so the scrolling inputs panel never clips it). Hover/focus shows it; click pins it (touch).
  const FIELDS = {};
  GROUPS.forEach(g => g.fields.forEach(fd => { FIELDS[fd.k] = fd; }));
  let tipEl = null, pinned = null, hideTimer = null;
  function tipShow(btn) {
    const fd = FIELDS[btn.dataset.tip];
    if (!fd) return;
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
    tipEl.innerHTML = `<strong>${esc(fd.label)}</strong><p>${esc(fd.tip)}</p><a href="${DOC}#${esc(fd.k)}" target="_blank" rel="noopener">How to estimate this for a client ↗</a>`;
    tipEl.hidden = false;
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
      const models = (TC.store.get('models') || { models: [] }).models.filter(m => m.self_hostable);
      const tipBtn = fd => fd.tip
        ? `<button type="button" class="tip-btn" data-tip="${esc(fd.k)}" aria-label="What is ${esc(fd.label)}?">?</button>`
        : '';
      const field = fd => {
        const id = 'in-' + fd.k;
        const val = w[fd.k];
        let ctl;
        if (fd.type === 'checkbox') {
          return `<div class="field check"><input type="checkbox" id="${id}" data-k="${fd.k}" ${val ? 'checked' : ''}><label for="${id}">${esc(fd.label)}</label>${tipBtn(fd)}</div>`;
        }
        if (fd.type === 'model') {
          ctl = `<select id="${id}" data-k="${fd.k}">` + models.map(m => `<option value="${esc(m.id)}" ${m.id === val ? 'selected' : ''}>${esc(m.name)}</option>`).join('') + '</select>';
        } else if (fd.type === 'select') {
          ctl = `<select id="${id}" data-k="${fd.k}" ${typeof fd.options[0] === 'object' && typeof fd.options[0][0] === 'number' ? 'data-num="1"' : ''}>` + fd.options.map(o => {
            const [ov, ol] = Array.isArray(o) ? o : [o, o];
            return `<option value="${esc(ov)}" ${String(ov) === String(val) ? 'selected' : ''}>${esc(ol)}</option>`;
          }).join('') + '</select>';
        } else {
          const locked = fd.k === 'peak_concurrent_requests' && w.peak_concurrency_mode === 'derived';
          ctl = `<input type="number" id="${id}" data-k="${fd.k}" value="${esc(val)}" ${fd.min != null ? `min="${fd.min}"` : ''} ${fd.max != null ? `max="${fd.max}"` : ''} step="${fd.step || 1}" ${locked ? 'readonly class="derived" title="Calculated from the traffic pattern — switch Peak concurrency to manual to edit"' : ''}>`;
        }
        if (fd.only && w.peak_concurrency_mode !== fd.only) return '';
        return `<div class="field"><div class="field-label"><label for="${id}">${esc(fd.label)}</label>${tipBtn(fd)}</div>${ctl}${fd.hint ? `<small>${esc(fd.hint)}</small>` : ''}</div>`;
      };

      el.innerHTML = `<form class="inputs-form" onsubmit="return false">
        <div class="inputs-head"><h2>Workload profile</h2>
          <a class="guide-link" href="${DOC}" target="_blank" rel="noopener">How to gather these inputs from a client ↗</a></div>
        ${GROUPS.map(g => `<fieldset><legend>${esc(g.title)}</legend>${g.fields.map(field).join('')}</fieldset>`).join('')}
        <div class="btn-row">
          <button type="button" class="btn ghost" data-act="reset">Reset</button>
          <button type="button" class="btn ghost" data-act="export">Export scenario</button>
          <button type="button" class="btn ghost" data-act="import">Import scenario</button>
        </div>
        <input type="file" accept=".json" hidden data-act="file"></form>`;
      const form = el.firstElementChild;

      form.addEventListener('input', e => {
        const t = e.target;
        if (!t.dataset.k) return;
        let val;
        if (t.type === 'checkbox') val = t.checked;
        else if (t.type === 'number' || t.dataset.num) { val = parseFloat(t.value); if (!isFinite(val)) return; }
        if (t.type === 'file') return;
        else val = t.value;
        if (t.readOnly) return;
        w[t.dataset.k] = val;
        if (t.dataset.k === 'model_id') TC.track('model-' + val, 'Compared model ' + val);
        this.save(w);
        if (t.dataset.k === 'peak_concurrency_mode') this.render(el, w, onChange);
        onChange();
      });

      const fileIn = el.querySelector('[data-act="file"]');
      el.querySelector('[data-act="reset"]').onclick = () => {
        Object.keys(w).forEach(k => delete w[k]);
        Object.assign(w, this.defaults());
        this.save(w);
        this.render(el, w, onChange);
        onChange();
      };
      el.querySelector('[data-act="export"]').onclick = () => TC.download('scenario-' + TC.today() + '.json', { tc_scenario: 1, workload: w });
      el.querySelector('[data-act="import"]').onclick = () => fileIn.click();
      fileIn.onchange = async () => {
        const file = fileIn.files[0];
        if (!file) return;
        try {
          const obj = JSON.parse(await file.text());
          Object.assign(w, obj.workload || obj);
          this.save(w);
          this.render(el, w, onChange);
          onChange();
        } catch (e) { alert('Could not import scenario: ' + e.message); }
      };
    },
  };
})();
