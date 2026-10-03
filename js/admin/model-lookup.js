/*
 * "Add a model by name" for the admin console. No AI: it reads two public sources and maps fields by fixed rules.
 *   - Hugging Face: the model's own config.json (layers, heads, KV heads, head size, context, MLA / sliding-window
 *     attention, MoE experts) and the repo's parameter count (safetensors metadata).
 *   - OpenRouter: list prices for the model (matched by its Hugging Face id) and each hosting provider's price.
 * The result is a draft in the models.json format, with every number wrapped {value, source, as_of, status}; the
 * console shows it for review before anything is queued as a pending change.
 *
 *   TC.modelLookup.search(q)          -> { hf: [{ id, downloads, gated }], or: [{ id, name, hf }] }
 *   TC.modelLookup.draftOpen(hfId)    -> { model, warnings, offers }   (offers = API rows the reviewer can tick)
 *   TC.modelLookup.draftClosed(orId)  -> { model, warnings, offers }
 */
(function () {
  const TC = window.TC;
  const v = TC.v, HF = 'https://huggingface.co', OR = 'https://openrouter.ai/api/v1';
  let orCache = null;

  async function getJson(url, what) {
    let res;
    try { res = await fetch(url, { cache: 'no-store' }); } catch (e) { throw new Error(`Could not reach ${what} (network or browser block).`); }
    if (res.status === 401 || res.status === 403) { const e = new Error(`${what} needs a sign-in for this model (gated repo).`); e.gated = true; throw e; }
    if (!res.ok) throw new Error(`${what} answered ${res.status}.`);
    return res.json();
  }
  async function orModels() {
    if (!orCache) orCache = (await getJson(OR + '/models', 'OpenRouter')).data || [];
    return orCache;
  }
  const perM = x => (x == null || x === '' || !isFinite(Number(x)) ? null : Math.round(Number(x) * 1e6 * 10000) / 10000);
  const W = (value, source, status) => ({ value, source, as_of: TC.today(), status: status || 'estimate' });
  const slug = s => s.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
  const VENDOR = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', 'x-ai': 'xAI', mistralai: 'Mistral', deepseek: 'DeepSeek',
    'meta-llama': 'Meta', qwen: 'Qwen', moonshotai: 'Moonshot AI', minimax: 'MiniMax', amazon: 'Amazon', cohere: 'Cohere', 'z-ai': 'Z.ai', microsoft: 'Microsoft' };
  const vendorOf = id => VENDOR[id.split('/')[0].toLowerCase()] || id.split('/')[0];

  async function search(q) {
    q = q.trim();
    if (!q) return { hf: [], or: [] };
    const hfP = getJson(`${HF}/api/models?search=${encodeURIComponent(q)}&filter=text-generation&sort=downloads&direction=-1&limit=25`, 'Hugging Face')
      .then(list => list.filter(m => !/gguf|gptq|awq|exl2|mlx|bnb|-\d+bit/i.test(m.id || m.modelId)).slice(0, 10).map(m => ({ id: m.id || m.modelId, downloads: m.downloads || 0, gated: !!m.gated })))
      .catch(e => { console.warn(e); return []; });
    const orP = orModels().then(list => {
      const words = q.toLowerCase().split(/\s+/);
      return list.filter(m => !m.id.startsWith('~') && !/:(batch|free|thinking|extended|beta)$/.test(m.id)).filter(m => words.every(w => (m.id + ' ' + m.name).toLowerCase().includes(w)))
        .slice(0, 12).map(m => ({ id: m.id, name: m.name, hf: m.hugging_face_id || '' }));
    }).catch(e => { console.warn(e); return []; });
    const [hf, or] = await Promise.all([hfP, orP]);
    return { hf, or };
  }

  /** API rows the reviewer can choose from: OpenRouter's own listed price plus each hosting provider's price. */
  async function offersFor(orModel, mode) {
    const src = `openrouter.ai/api/v1/models (${orModel.id})`, p = orModel.pricing || {};
    const offers = [];
    if (perM(p.prompt) != null) offers.push({ on: true, label: mode === 'mirror' ? `${vendorOf(orModel.id)} list price (via OpenRouter)` : 'OpenRouter (routed marketplace)', row: {
      provider: mode === 'mirror' ? vendorOf(orModel.id) : 'OpenRouter',
      input_per_m: W(perM(p.prompt), src), output_per_m: W(perM(p.completion), src),
      cached_input_per_m: perM(p.input_cache_read) != null ? W(perM(p.input_cache_read), src) : null, batch_discount_pct: null,
      ...(mode === 'own' ? { note: 'OpenRouter routes each request to one of several hosting providers; this is its listed price for the model. Throughput, rate limits and data-handling terms depend on the underlying provider.' } : {}),
      feed: { source: 'openrouter', id: orModel.id, mode },
    } });
    if (mode === 'own') {
      try {
        const ep = ((await getJson(`${OR}/models/${orModel.id}/endpoints`, 'OpenRouter endpoints')).data || {}).endpoints || [];
        const seen = new Set();
        ep.forEach(e => {
          const name = e.provider_name, q = e.pricing || {};
          if (!name || seen.has(name) || perM(q.prompt) == null) return;
          seen.add(name);
          const s = `openrouter.ai endpoints (${orModel.id}, ${name})`;
          offers.push({ on: false, label: name + (e.quantization && e.quantization !== 'unknown' ? ` · ${e.quantization}` : ''), row: {
            provider: name, input_per_m: W(perM(q.prompt), s), output_per_m: W(perM(q.completion), s),
            cached_input_per_m: perM(q.input_cache_read) != null ? W(perM(q.input_cache_read), s) : null, batch_discount_pct: null,
            feed: { source: 'openrouter-endpoint', id: orModel.id, provider: name },
          } });
        });
      } catch (e) { console.warn(e); }
      // Pre-tick the four cheapest direct providers: OpenRouter itself is excluded from comparisons by default.
      const cost = o => v(o.row.input_per_m) * 3 + v(o.row.output_per_m);
      offers.slice(1).sort((a, b) => cost(a) - cost(b)).slice(0, 4).forEach(o => { o.on = true; });
    }
    return offers;
  }

  async function draftOpen(hfId) {
    const warnings = [];
    const [cfgRaw, info] = await Promise.all([
      getJson(`${HF}/${hfId}/resolve/main/config.json`, 'Hugging Face config.json').catch(e => {
        if (/404/.test(e.message)) throw new Error(`${hfId} has no config.json (often a quantized or GGUF copy). Pick the original repo from the model’s publisher.`);
        throw e;
      }),
      getJson(`${HF}/api/models/${hfId}`, 'Hugging Face model info').catch(() => ({})),
    ]);
    const c = cfgRaw.text_config || cfgRaw.language_config || cfgRaw.llm_config || cfgRaw;
    const src = `Hugging Face config.json (${hfId})`, need = (x, label) => { if (x == null) warnings.push(`${label} not found in config.json: fill it in.`); return x == null ? null : x; };
    const layers = need(c.num_hidden_layers || c.n_layer || c.num_layers, 'Layers');
    const heads = need(c.num_attention_heads || c.n_head, 'Attention heads');
    const kv = c.num_key_value_heads || c.multi_query_group_num || heads;
    const headDim = c.head_dim || c.v_head_dim || (c.hidden_size && heads ? c.hidden_size / heads : null);
    if (headDim == null) warnings.push('Head size not found in config.json: fill it in.');
    let ctx = c.max_position_embeddings || c.seq_length || c.n_positions || null;
    if (!ctx) warnings.push('Maximum context not found: fill it in.');

    // Parameters: the repo's safetensors metadata counts every weight (it is a count, not bytes, so FP8 / 4-bit files are fine).
    const totalCount = info.safetensors && info.safetensors.total;
    let total = totalCount ? Math.round(totalCount / 1e8) / 10 : null;
    if (total == null) warnings.push('Hugging Face does not list a parameter count for this repo: enter total parameters (billions).');

    // MoE: active = total minus the experts a token does not use.
    const E = c.n_routed_experts || c.num_local_experts || c.num_experts || 0, k = c.num_experts_per_tok || c.moe_topk || c.num_experts_per_token || 0;
    const moe = E > 1 && k > 0;
    let active = total, activeSrc = 'Same as total (dense model)', activeStatus = 'estimate';
    if (moe) {
      const ff = c.moe_intermediate_size || c.expert_intermediate_size || c.intermediate_size;
      const dense = c.first_k_dense_replace || 0, every = c.moe_layer_freq || c.decoder_sparse_step || 1;
      const mtp = c.num_nextn_predict_layers || 0;  // DeepSeek-style extra prediction layer: in the checkpoint, full of experts
      const moeLayers = Math.ceil((layers - dense) / every) + mtp;
      if (mtp) warnings.push(`The checkpoint includes ${mtp} multi-token-prediction layer(s), so its parameter count is a little above the headline figure on the model card.`);
      if (total != null && ff && c.hidden_size) {
        const perExpert = 3 * c.hidden_size * ff;  // gate, up and down projections
        active = Math.round((total * 1e9 - (E - k) * perExpert * moeLayers) / 1e8) / 10;
        activeSrc = `Derived from config.json: total minus unused experts (${E} experts, ${k} per token, ${moeLayers} MoE layers). Check against the model card.`;
      } else { active = null; activeSrc = 'Could not derive: enter from the model card'; warnings.push('MoE model: enter active parameters from the model card.'); }
      if (active != null && (active <= 0 || active > total)) { active = null; warnings.push('Active-parameter estimate did not make sense: enter it from the model card.'); }
      activeStatus = 'placeholder';
      warnings.push('Active parameters are estimated from the expert layout; confirm against the model card.');
    }

    let kvLayout = null;
    if (c.kv_lora_rank) {
      kvLayout = { type: 'mla', elems_per_token_per_layer: c.kv_lora_rank + (c.qk_rope_head_dim || 0),
        source: `${src}: kv_lora_rank ${c.kv_lora_rank} + qk_rope_head_dim ${c.qk_rope_head_dim || 0}`, as_of: TC.today(), status: 'estimate' };
    } else if (Array.isArray(c.layer_types) && c.sliding_window) {
      const sl = c.layer_types.filter(t => /sliding/.test(t)).length, full = c.layer_types.length - sl;
      if (sl) kvLayout = { type: 'hybrid_sliding', full_layers: full, sliding_layers: sl, window: c.sliding_window,
        source: `${src} layer_types / sliding_window`, as_of: TC.today(), status: 'estimate' };
    } else if (c.sliding_window && c.use_sliding_window === false) { /* sliding window declared but switched off */ }
    else if (c.sliding_window && c.sliding_window < (ctx || Infinity) && !c.layer_types) warnings.push(`config.json declares a ${c.sliding_window}-token sliding window without per-layer types; treated as full attention (larger KV cache, conservative).`);
    if (Array.isArray(c.layer_types) && c.layer_types.some(t => /linear|mamba|ssm/.test(t))) warnings.push('Some layers use linear/state-space attention; KV sizing treats every layer as attention (conservative).');

    const q = cfgRaw.quantization_config || c.quantization_config;
    const native = q ? `${(q.quant_method || 'quantized').toUpperCase()}${q.bits ? ' ' + q.bits + '-bit' : ''} weights in the published checkpoint` : null;
    const base = hfId.split('/').pop();
    const model = {
      id: slug(base), name: base.replace(/[-_]/g, ' ') + (moe ? ' (MoE)' : ''), family: vendorOf(hfId), self_hostable: true, architecture: moe ? 'moe' : 'dense',
      params_total_b: W(total, `Hugging Face safetensors metadata (${hfId})`),
      params_active_b: W(active, activeSrc, activeStatus),
      layers: W(layers, src), attention_heads: W(heads, src), kv_heads: W(kv, src), head_dim: W(headDim, src), max_context: W(ctx, src),
      ...(kvLayout ? { kv_layout: kvLayout } : {}),
      ...(native ? { native_precision: native } : {}),
      hf_id: hfId,
      api_prices: [],
    };
    let offers = [];
    try {
      const list = await orModels();
      const hit = list.filter(m => (m.hugging_face_id || '').toLowerCase() === hfId.toLowerCase());
      for (const m of hit) offers = offers.concat(await offersFor(m, 'own'));
      if (!hit.length) warnings.push('OpenRouter does not list this exact Hugging Face model, so no API prices were found. The model will only appear in on-prem and GPU-cloud sizing until API prices are added in the Data editor.');
    } catch (e) { warnings.push('OpenRouter could not be reached; add API prices later.'); }
    return { model, warnings, offers };
  }

  async function draftClosed(orId) {
    const m = (await orModels()).find(x => x.id === orId);
    if (!m) throw new Error('That model is no longer listed on OpenRouter.');
    const n = (m.name || orId).replace(/^[^:]+:\s*/, '');
    const tier = /mini|nano|flash|haiku|lite|small|fast/i.test(n) ? 'budget' : /opus|pro\b|ultra|max/i.test(n) ? 'frontier' : 'mid';
    const model = { id: slug(orId.split('/').pop()), name: n, family: vendorOf(orId), tier, self_hostable: false, architecture: null,
      note: 'API-only reference model (weights not available for self-hosting). Not an apples-to-apples quality comparison with open-weight models.', api_prices: [] };
    const warnings = ['Tier is a first guess from the name (mini / Flash / Haiku → budget; Opus / Pro → frontier; otherwise mid). Check it matches the vendor’s positioning.'];
    if (m.hugging_face_id) warnings.push(`OpenRouter links this to an open-weight repo (${m.hugging_face_id}). If it can be self-hosted, add it from the Hugging Face column instead.`);
    return { model, warnings, offers: await offersFor(m, 'mirror') };
  }

  TC.modelLookup = { search, draftOpen, draftClosed };
})();
