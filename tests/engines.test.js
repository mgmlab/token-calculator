/* Engine tests with hand-computed expected values. Open tests/index.html through the local server. */
(function () {
  const TC = window.TC;
  const results = [];
  const E = v => ({ value: v, source: 'test', as_of: '2026-01-01', status: 'estimate' });
  const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
  function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, msg: e.message }); }
  }
  function eq(actual, expected, label, tol) {
    if (typeof expected === 'number' ? !near(actual, expected, tol) : actual !== expected) {
      throw new Error(`${label || 'value'}: expected ${expected}, got ${actual}`);
    }
  }

  // ---------- fixtures (independent of /data so tests stay stable)
  const llama70 = {
    id: 'm70', name: 'Llama 70B', self_hostable: true,
    params_total_b: E(70), params_active_b: E(70), layers: E(80), attention_heads: E(64), kv_heads: E(8), head_dim: E(128), max_context: E(131072),
    kv_layout: { type: 'standard' }, api_prices: [],
  };
  const gptoss = {
    id: 'oss', name: 'oss', self_hostable: true,
    params_total_b: E(116.8), params_active_b: E(5.1), layers: E(36), attention_heads: E(64), kv_heads: E(8), head_dim: E(64), max_context: E(131072),
    kv_layout: { type: 'hybrid_sliding', full_layers: 18, sliding_layers: 18, window: 128 },
  };
  const dsv3 = { id: 'ds', name: 'ds', layers: E(61), kv_heads: E(128), head_dim: E(128), kv_layout: { type: 'mla', elems_per_token_per_layer: 576 } };
  const gpu80 = { id: 'g80', name: 'G80', memory_gb: E(80), mem_bandwidth_tbps: E(3.35), power_kw: E(0.7), dense_tflops_fp16: E(989), dense_tflops_fp8: E(1979), street_price_usd: E(25000), cloud: [] };
  const assumptions = {
    power: { pue: E(1.5), electricity_usd_per_kwh: E(0.1), load_factor_pct: E(100) },
    onprem: {
      memory_overhead_pct: E(0), support_pct_per_year: E(10), net_storage_mode: 'pct_of_servers', net_storage_pct_of_servers: E(10),
      net_storage_usd_per_node: E(0), install_usd_per_node: E(0), software_usd_per_gpu_per_year: E(0), ops_fte: E(0), ops_fte_cost_usd_per_year: E(0),
      residual_value_pct: E(0), financing_rate_pct_per_year: E(0), colo_enabled: false, colo_usd_per_kw_month: E(0), colo_includes_power: false, kw_per_rack: E(40),
    },
    throughput: { roofline_bandwidth_efficiency_pct: E(100), roofline_compute_efficiency_pct: E(100), prefill_warning_ratio: 10 },
    cloud: { hours_per_month: 730 },
  };
  const baseW = {
    users: 100, requests_per_user_per_day: 10, avg_input_tokens: 1000, avg_output_tokens: 500, active_days_per_month: 30,
    peak_concurrent_requests: 10, target_output_tps_per_request: 10, max_context: 8192, model_id: 'm70',
    precision: 'FP8', kv_precision: 'FP16', kv_sizing_basis: 'typical', term_years: 3, headroom_pct: 0, n_plus_one: false,
    throughput_source: 'benchmark_then_theoretical', cloud_active_hours_per_month: 730, api_cache_hit_pct: 0, api_batch_share_pct: 0, include_closed_models: false,
  };

  // ---------- workload
  test('workload token volumes', () => {
    const wl = TC.workload(baseW);
    eq(wl.reqDay, 1000, 'req/day');
    eq(wl.tInMo, 1000 * 30 * 1000, 'input/month');
    eq(wl.tOutMo, 1000 * 30 * 500, 'output/month');
    eq(wl.tTerm, (30e6 + 15e6) * 36, 'term tokens');
  });

  test('derived peak concurrency: busy-hour Little\'s law + Poisson burst', () => {
    const w = Object.assign({}, baseW, { users: 500, requests_per_user_per_day: 20, avg_output_tokens: 400, target_output_tps_per_request: 20,
      peak_concurrency_mode: 'derived', busy_hour_share_pct: 15, burst_percentile: 99 });
    const we = TC.effectiveWorkload(w);
    // 10,000 req/day × 15% ÷ 3,600 = 0.4167 req/s × (400/20 + 1) s = 8.75 → ceil(8.75 + 2.326 × √8.75) = 16
    eq(we._peak.mean, 10000 * 0.15 / 3600 * 21, 'mean');
    eq(we.peak_concurrent_requests, 16, 'peak');
    const big = TC.effectiveWorkload(Object.assign({}, w, { users: 50000 }));
    if (!(big.peak_concurrent_requests / big._peak.mean < we.peak_concurrent_requests / we._peak.mean)) throw new Error('burst ratio should shrink with volume');
  });
  test('manual peak passes through unchanged', () => {
    eq(TC.effectiveWorkload(Object.assign({}, baseW, { peak_concurrency_mode: 'manual' })).peak_concurrent_requests, baseW.peak_concurrent_requests, 'peak');
  });
  test('utilization = average output demand ÷ installed capacity', () => {
    const wl = TC.workload(baseW);
    const u = TC.utilization({ pp: 1, tp: 2, nodes: 1, replicas: 1, aggTps: 1000 }, 8, wl);
    eq(u.capacity, 4000, 'capacity (4 replica slots per 8-GPU node)');
    eq(u.demand, wl.tOutMo / (730 * 3600), 'demand');
  });

  // ---------- KV cache
  test('KV standard: Llama 70B, 1 token FP16 = 327,680 bytes', () => {
    eq(TC.kvBytes(llama70, 'FP16', 1).bytes, 2 * 80 * 8 * 128 * 2);
  });
  test('KV standard scales with length and precision', () => {
    eq(TC.kvBytes(llama70, 'FP8', 1500).bytes, 2 * 80 * 8 * 128 * 1 * 1500);
  });
  test('KV hybrid sliding: gpt-oss-120b at 1,000 tokens', () => {
    eq(TC.kvBytes(gptoss, 'FP16', 1000).bytes, 2 * 8 * 64 * 2 * (18 * 1000 + 18 * 128));
  });
  test('KV MLA: DeepSeek V3 per token = 61 × 576 × 2', () => {
    eq(TC.kvBytes(dsv3, 'FP16', 1).bytes, 61 * 576 * 2);
  });

  // ---------- sizing
  test('TP1 fits at FP8 but not FP16; TP2 KV capacity', () => {
    const s = TC.sizeOnGpu({ model: llama70, gpu: gpu80, gpn: 8, w: baseW, a: assumptions, benchmarks: [] });
    const tp1 = s.candidates.find(c => c.tp === 1), tp2 = s.candidates.find(c => c.tp === 2);
    eq(tp1.feasible, true, 'TP1 feasible (70 GB FP8 < 80 GB, 0% overhead)');
    const s16 = TC.sizeOnGpu({ model: llama70, gpu: gpu80, gpn: 8, w: Object.assign({}, baseW, { precision: 'FP16' }), a: assumptions, benchmarks: [] });
    eq(s16.candidates.find(c => c.tp === 1).feasible, false, 'TP1 FP16 infeasible (140 GB)');
    eq(tp2.feasible, true, 'TP2');
    // TP2: free = 160 - 70 = 90 GB; KV/request = 327,680 × 1,500 = 0.49152 GB -> floor(90 / 0.49152) = 183
    eq(tp2.Crep, Math.floor(90 / 0.49152), 'Crep TP2');
  });
  test('benchmark used when it matches exactly; replicas from throughput', () => {
    const bench = [{ gpu_id: 'g80', model_id: 'm70', precision: 'FP8', tp: 2, pp: 1, aggregate_output_tps: E(40), per_request_output_tps: E(12), concurrency: 8, input_len: 1000, output_len: 500 }];
    const w = Object.assign({}, baseW, { headroom_pct: 50 });
    const s = TC.sizeOnGpu({ model: llama70, gpu: gpu80, gpn: 8, w, a: assumptions, benchmarks: bench });
    const tp2 = s.candidates.find(c => c.tp === 2);
    eq(tp2.basis, 'benchmark', 'basis');
    // required 10 × 10 = 100 tok/s ÷ 40 = 2.5 replicas of exact need; × 1.5 headroom = 3.75 -> 4 (rounded once)
    eq(tp2.replicas, 4, 'replicas');
    // 4 replicas at 4 per 8-GPU node -> 1 node, 8 GPUs
    eq(tp2.nodes, 1, 'nodes'); eq(tp2.gpus, 8, 'gpus');
    eq(s.best, tp2, 'benchmarked layout preferred over theoretical ones');
  });
  test('N+1 adds one spare server', () => {
    const bench = [{ gpu_id: 'g80', model_id: 'm70', precision: 'FP8', tp: 2, pp: 1, aggregate_output_tps: E(1000) }];
    const off = TC.sizeOnGpu({ model: llama70, gpu: gpu80, gpn: 8, w: baseW, a: assumptions, benchmarks: bench });
    const on = TC.sizeOnGpu({ model: llama70, gpu: gpu80, gpn: 8, w: Object.assign({}, baseW, { n_plus_one: true }), a: assumptions, benchmarks: bench });
    eq(on.best.replicas, off.best.replicas, 'replicas unchanged');
    eq(on.best.nodes, off.best.nodes + 1, 'one more server');
    eq(on.best.gpus, off.best.gpus + 8, 'a full server of GPUs');
    eq(on.best.spareNodes, 1, 'spare recorded');
  });
  test('TP8 not valid on 4-GPU node; pipeline parallel when nothing fits', () => {
    const w = Object.assign({}, baseW, { precision: 'FP16' });
    const big = Object.assign({}, llama70, { params_total_b: E(405), params_active_b: E(405), attention_heads: E(128) });
    const s = TC.sizeOnGpu({ model: big, gpu: gpu80, gpn: 4, w, a: assumptions, benchmarks: [] });
    eq(s.candidates.some(c => c.tp === 8), false, 'no TP8');
    eq(s.candidates.some(c => c.pp > 1), true, 'PP candidates added');
  });
  test('theoretical estimate meets per-request speed target', () => {
    const s = TC.sizeOnGpu({ model: llama70, gpu: gpu80, gpn: 8, w: baseW, a: assumptions, benchmarks: [] });
    const c = s.best;
    eq(c.basis, 'theoretical', 'basis');
    if (!(c.perReqTps >= baseW.target_output_tps_per_request)) throw new Error('per-request tps below target: ' + c.perReqTps);
  });

  // ---------- cost
  test('on-prem cost components', () => {
    const bench = [{ gpu_id: 'g80', model_id: 'm70', precision: 'FP8', tp: 2, pp: 1, aggregate_output_tps: E(1000) }];
    const s = TC.sizeOnGpu({ model: llama70, gpu: gpu80, gpn: 8, w: baseW, a: assumptions, benchmarks: bench });
    const server = { vendor: 'V', sku: 'S', gpus_per_node: 8, price_mode: 'all_in', price_usd: E(200000), power_kw: E(10) };
    const wl = TC.workload(baseW);
    const c = TC.onpremCost({ sizing: s, server, gpu: gpu80, w: baseW, wl, a: assumptions });
    eq(c.nodes, 1, 'nodes');
    eq(c.breakdown.net, 20000, 'network 10%');
    eq(c.breakdown.support, 200000 * 0.1 * 3, 'support');
    eq(c.breakdown.power, 10 * 1 * 1.5 * 8760 * 3 * 0.1, 'power');
    eq(c.total, 200000 + 20000 + 60000 + 39420, 'total');
    eq(c.perM, c.total / (wl.tTerm / 1e6), '$/M');
  });
  test('base_plus_gpus pricing mode', () => {
    const bench = [{ gpu_id: 'g80', model_id: 'm70', precision: 'FP8', tp: 2, pp: 1, aggregate_output_tps: E(1000) }];
    const s = TC.sizeOnGpu({ model: llama70, gpu: gpu80, gpn: 8, w: baseW, a: assumptions, benchmarks: bench });
    const server = { vendor: 'V', sku: 'S', gpus_per_node: 8, price_mode: 'base_plus_gpus', base_price_usd: E(50000), power_kw: E(10) };
    const c = TC.onpremCost({ sizing: s, server, gpu: gpu80, w: baseW, wl: TC.workload(baseW), a: assumptions });
    eq(c.breakdown.capexServers, 50000 + 8 * 25000, 'capex');
  });

  // ---------- API
  test('API cost with cache and batch', () => {
    const model = { id: 'x', name: 'X', self_hostable: true };
    const price = { provider: 'P', input_per_m: E(1), output_per_m: E(4), cached_input_per_m: E(0.1), batch_discount_pct: E(50) };
    const w = Object.assign({}, baseW, { api_cache_hit_pct: 50, api_batch_share_pct: 20 });
    const wl = TC.workload(w);
    const r = TC.apiRow(model, price, w, wl);
    const effIn = 0.5 * 1 + 0.5 * 0.1;
    const expected = (wl.tInMo / 1e6 * effIn + wl.tOutMo / 1e6 * 4) * (1 - 0.2 * 0.5);
    eq(r.monthly, expected, 'monthly');
    eq(r.total, expected * 36, 'term');
  });

  // ---------- cloud
  test('cloud reserved and on-demand', () => {
    const g = Object.assign({}, gpu80, { cloud: [{ provider: 'C', instance: 'i', gpus_per_instance: 8, on_demand_per_gpu_hr: E(4), reserved_per_gpu_hr: E(3), reserved_term: '3 yr' }] });
    const bench = [{ gpu_id: 'g80', model_id: 'm70', precision: 'FP8', tp: 2, pp: 1, aggregate_output_tps: E(1000) }];
    const data = { models: { models: [llama70] }, gpus: { gpus: [g] }, benchmarks: { benchmarks: bench }, assumptions };
    const w = Object.assign({}, baseW, { cloud_active_hours_per_month: 200 });
    const rows = TC.runCloud(data, w, TC.workload(w));
    const res = rows.find(r => r.category === 'cloud_reserved'), od = rows.find(r => r.category === 'cloud_ondemand');
    eq(res.monthly, 8 * 3 * 730, 'reserved');
    eq(od.monthly, 8 * 4 * 200, 'on-demand');
  });

  test('reserved rate picks the longest commitment within the term', () => {
    const offer = { reserved_terms_per_gpu_hr: { '1': E(8), '3': E(5), '5': E(4) } };
    eq(TC.pickReserved(offer, 3).years, 3, '3-yr term → 3-yr rate');
    eq(TC.pickReserved(offer, 5).years, 5, '5-yr term → 5-yr rate');
    const no5 = { reserved_terms_per_gpu_hr: { '1': E(8), '3': E(5) } };
    const r = TC.pickReserved(no5, 5);
    eq(r.years, 3, '5-yr term without 5-yr rate → 3-yr rate');
    eq(r.flags.length, 1, 'flagged');
    eq(TC.pickReserved({ reserved_per_gpu_hr: E(6), reserved_term: '1 yr' }, 3).rate.value, 6, 'legacy single rate');
    eq(TC.pickReserved({}, 3), null, 'no reserved rate');
  });

  test('economic-fit verdict thresholds', () => {
    const V = o => TC.fitVerdict(Object.assign({ multiple: Infinity }, o)).key;
    eq(V({ onMonthly: 90, apiMonthly: 100, cloudMonthly: 120 }), 'onprem', 'cheapest of all');
    eq(V({ onMonthly: 90, apiMonthly: 100, cloudMonthly: 120, onHigh: 95 }), 'onprem', 'cheaper even in the pessimistic case');
    eq(V({ onMonthly: 90, apiMonthly: 100, cloudMonthly: 120, onHigh: 130 }), 'onprem-likely', 'range overlaps the next option');
    eq(V({ onMonthly: 100, apiMonthly: 120, cloudMonthly: 80 }), 'cloud', 'on-prem beats the API but GPU cloud is cheaper');
    eq(V({ onMonthly: 100, apiMonthly: null, cloudMonthly: 80 }), 'cloud', 'no API price; cloud cheapest');
    eq(V({ onMonthly: 150, apiMonthly: 100, cloudMonthly: 200, multiple: 2.5 }), 'near', 'API cheapest, within 3x');
    eq(V({ onMonthly: 150, apiMonthly: 100, cloudMonthly: 200, multiple: 9, hybridWins: true }), 'hybrid', 'hybrid mix wins');
    eq(V({ onMonthly: 900, apiMonthly: 100, cloudMonthly: 300, multiple: 40 }), 'api', 'far from breakeven');
    eq(V({ onMonthly: 900, apiMonthly: 100, cloudMonthly: 300 }), 'api', 'never in range');
    eq(V({ onMonthly: null, apiMonthly: 100, cloudMonthly: 80 }), 'unknown', 'no data');
  });

  test('hybrid traffic profile and served fraction', () => {
    const flat = TC.trafficProfile(0.04);
    eq(flat.length, 24, 'hours'); eq(Math.max(...flat), 1 / 24, 'flat when share <= 1/24');
    const biz = TC.trafficProfile(0.15);
    eq(Math.max(...biz), 0.15, 'busiest hour share', 1e-3);
    eq(biz.reduce((a, b) => a + b, 0), 1, 'sums to 1', 1e-9);
    eq(TC.servedFraction(10, 0), 0, 'no capacity');
    if (!(TC.servedFraction(10, 1000) > 0.999)) throw new Error('huge capacity should serve ~all');
    // Poisson(2), K = 1: E[min(X,1)] = P(X>=1) = 1 - e^-2 -> fraction = (1 - e^-2) / 2
    eq(TC.servedFraction(2, 1), (1 - Math.exp(-2)) / 2, 'exact Poisson', 1e-9);
    // normal branch continuity near the 30 threshold
    if (Math.abs(TC.servedFraction(29.9, 30) - TC.servedFraction(30, 30)) > 0.02) throw new Error('approximation discontinuity');
  });

  // ---------- render
  const ok = results.filter(r => r.ok).length;
  document.getElementById('summary').textContent = `${ok} / ${results.length} passed`;
  document.getElementById('summary').className = ok === results.length ? 'pass' : 'fail';
  document.getElementById('list').innerHTML = results.map(r =>
    `<li class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${TC.esc(r.name)}${r.msg ? ' — ' + TC.esc(r.msg) : ''}</li>`).join('');
  window.TC_TEST_RESULTS = results;
})();
