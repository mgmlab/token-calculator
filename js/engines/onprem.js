/* On-prem sizing (replicas, GPUs, nodes) and total cost of ownership. */
(function () {
  const TC = window.TC;
  const S = TC.step;
  const f = TC.fmt;
  const v = TC.v;

  // ------------------------------------------------------------------ KV cache
  /**
   * KV-cache bytes for ONE sequence of length seqLen.
   *   standard:       2 × layers × kv_heads × head_dim × bytes × seqLen
   *   hybrid_sliding: 2 × kv_heads × head_dim × bytes × (full_layers × seqLen + sliding_layers × min(seqLen, window))
   *   mla:            layers × latent_elems × bytes × seqLen          (no factor 2: one shared latent)
   */
  TC.kvBytes = function (model, kvPrecision, seqLen) {
    const b = TC.BYTES_PER_PARAM[kvPrecision];
    const L = v(model.layers), Hkv = v(model.kv_heads), d = v(model.head_dim);
    const lay = model.kv_layout || { type: 'standard' };
    if (lay.type === 'mla') {
      const e = v(lay.elems_per_token_per_layer);
      return {
        bytes: L * e * b * seqLen,
        perToken: L * e * b,
        formula: `${L} layers × ${e} latent elems × ${b} B × ${f.int(seqLen)} tokens (MLA)`,
      };
    }
    if (lay.type === 'hybrid_sliding') {
      const full = v(lay.full_layers), sl = v(lay.sliding_layers), win = v(lay.window);
      const perLayerTok = 2 * Hkv * d * b;
      return {
        bytes: perLayerTok * (full * seqLen + sl * Math.min(seqLen, win)),
        perToken: perLayerTok * full,
        formula: `2 × ${Hkv} KV heads × ${d} head dim × ${b} B × (${full} full layers × ${f.int(seqLen)} + ${sl} sliding layers × min(${f.int(seqLen)}, ${win}))`,
      };
    }
    return {
      bytes: 2 * L * Hkv * d * b * seqLen,
      perToken: 2 * L * Hkv * d * b,
      formula: `2 × ${L} layers × ${Hkv} KV heads × ${d} head dim × ${b} B × ${f.int(seqLen)} tokens`,
    };
  };

  function tflopsFor(gpu, precision) {
    if (precision === 'FP8' && gpu.dense_tflops_fp8 && v(gpu.dense_tflops_fp8) != null) {
      return { tflops: gpu.dense_tflops_fp8, which: 'FP8' };
    }
    // FP16 compute, and INT4/FP8 weight-only kernels (W4A16 / W8A16) fall back to FP16 math.
    return { tflops: gpu.dense_tflops_fp16, which: 'FP16', note: precision !== 'FP16' ? `${precision} treated as weight-only quantization with FP16 math` : '' };
  }

  function validTPs(model, gpn) {
    const heads = v(model.attention_heads);
    return [1, 2, 4, 8].filter(tp => tp <= gpn && heads % tp === 0);
  }

  function findBenchmark(benchmarks, gpuId, modelId, precision, tp, pp) {
    return (benchmarks || []).find(b =>
      b.gpu_id === gpuId && b.model_id === modelId && b.precision === precision &&
      Number(b.tp) === tp && Number(b.pp || 1) === pp &&
      typeof v(b.aggregate_output_tps) === 'number' && v(b.aggregate_output_tps) > 0);
  }

  // ------------------------------------------------------------------ sizing
  /**
   * Evaluates every valid tensor/pipeline-parallel layout for one GPU type and node size,
   * returns them all plus the one with the fewest nodes.
   */
  TC.sizeOnGpu = function ({ model, gpu, gpn, w, a, benchmarks }) {
    const prov = new TC.Provenance();
    const o = prov.use('Memory overhead %', a.onprem.memory_overhead_pct) / 100;
    const memGb = prov.use(`${gpu.name} memory (GB)`, gpu.memory_gb);
    const Ptot = prov.use(`${model.name} total params (B)`, model.params_total_b);
    const Pact = prov.use(`${model.name} active params (B)`, model.params_active_b);
    prov.use(`${model.name} layers`, model.layers);
    prov.use(`${model.name} KV heads`, model.kv_heads);
    prov.use(`${model.name} head dim`, model.head_dim);
    const modelMaxCtx = prov.use(`${model.name} max context`, model.max_context);
    if (model.kv_layout && model.kv_layout.type !== 'standard') {
      prov.items.push({ label: `${model.name} KV layout (${model.kv_layout.type})`, value: model.kv_layout.type, source: model.kv_layout.source || '', as_of: model.kv_layout.as_of || '', status: model.kv_layout.status || '' });
    }

    const bpp = TC.BYTES_PER_PARAM[w.precision];
    const Wgb = Ptot * bpp;
    const WactGb = Pact * bpp;
    const ctxMax = Math.min(w.max_context, modelMaxCtx);
    const seqTypical = w.avg_input_tokens + w.avg_output_tokens;
    const seqSize = w.kv_sizing_basis === 'worst' ? ctxMax : Math.min(seqTypical, ctxMax);
    const kvSize = TC.kvBytes(model, w.kv_precision, seqSize);
    const kvWorst = TC.kvBytes(model, w.kv_precision, ctxMax);
    const kvAvgRead = TC.kvBytes(model, w.kv_precision, Math.min(w.avg_input_tokens + w.avg_output_tokens / 2, ctxMax));
    const KVreqGb = kvSize.bytes / 1e9;

    const shared = {
      Wgb, WactGb, bpp, seqSize, kvSize, kvWorst, KVreqGb, ctxMax,
      steps: [
        S('Weights memory', `${f.num(Ptot)}B params × ${bpp} bytes/param (${w.precision})`, Wgb, 'GB'),
        S('KV cache per request', kvSize.formula + (w.kv_sizing_basis === 'worst' ? ' — worst-case (max context)' : ' — typical (avg input + avg output)'), KVreqGb, 'GB',
          `KV precision ${w.kv_precision}. Paged-attention engines (vLLM, TensorRT-LLM, SGLang) allocate KV as sequences grow, so the typical basis is usually realistic.`),
      ],
    };

    const flags = [];
    if (w.max_context > modelMaxCtx) flags.push(`Requested max context ${f.int(w.max_context)} exceeds the model's ${f.int(modelMaxCtx)}; capped.`);

    const tps = validTPs(model, gpn);
    const layouts = tps.map(tp => ({ tp, pp: 1 }));
    const maxTp = tps[tps.length - 1];
    // Pipeline parallel across whole nodes only if nothing fits in a single node.
    const fitsOneNode = tps.some(tp => (tp * memGb) / (1 + o) - Wgb >= KVreqGb);
    if (!fitsOneNode && maxTp === gpn) {
      [2, 4].forEach(pp => layouts.push({ tp: maxTp, pp }));
    }

    const useBench = w.throughput_source !== 'theoretical_only';
    const useTheory = w.throughput_source !== 'benchmark_only';
    const bwEff = v(a.throughput.roofline_bandwidth_efficiency_pct) / 100;
    const cEff = v(a.throughput.roofline_compute_efficiency_pct) / 100;

    const candidates = layouts.map(({ tp, pp }) => {
      const g = tp * pp;
      const capGb = (g * memGb) / (1 + o);
      const freeGb = capGb - Wgb;
      const cand = { tp, pp, gpusPerReplica: g, capGb, freeGb, steps: [], flags: [] };
      cand.steps.push(S('Usable memory per replica', `${g} GPU × ${f.num(memGb)} GB ÷ (1 + ${f.num(o * 100)}% overhead)`, capGb, 'GB'));
      cand.steps.push(S('Memory left for KV cache', `${f.num(capGb)} − ${f.num(Wgb)} GB weights`, freeGb, 'GB'));
      if (freeGb < KVreqGb) {
        cand.feasible = false;
        cand.reason = freeGb <= 0 ? `Weights (${f.gb(Wgb)}) exceed usable memory (${f.gb(capGb)})` : 'Not enough memory for even one request\'s KV cache';
        return cand;
      }
      const Crep = Math.floor(freeGb / KVreqGb);
      cand.Crep = Crep;
      cand.steps.push(S('Max concurrent requests per replica (memory)', `floor(${f.num(freeGb)} ÷ ${f.num(KVreqGb, 4)} GB)`, Crep, 'requests'));
      if (freeGb < kvWorst.bytes / 1e9) {
        cand.flags.push(`A single max-context request (${f.int(ctxMax)} tokens, ${f.gb(kvWorst.bytes / 1e9)} KV) does not fit in a replica with this layout.`);
      }
      const repMem = Math.ceil(w.peak_concurrent_requests / Crep);
      cand.steps.push(S('Replicas needed for memory', `ceil(${f.int(w.peak_concurrent_requests)} peak concurrent ÷ ${f.int(Crep)})`, repMem, 'replicas'));
      const reqTps = w.peak_concurrent_requests * w.target_output_tps_per_request;
      cand.steps.push(S('Required aggregate output throughput', `${f.int(w.peak_concurrent_requests)} peak concurrent × ${f.num(w.target_output_tps_per_request)} tok/s per request`, reqTps, 'tok/s'));

      const bench = useBench ? findBenchmark(benchmarks, gpu.id, model.id, w.precision, tp, pp) : null;
      let base;
      if (bench) {
        const B = v(bench.aggregate_output_tps);
        cand.basis = 'benchmark';
        cand.bench = bench;
        cand.aggTps = B;
        const repTput = Math.ceil(reqTps / B);
        cand.steps.push(S('Benchmarked aggregate output tok/s per replica', `${bench.engine || '?'} ${bench.engine_version || ''} · in ${f.int(bench.input_len)} / out ${f.int(bench.output_len)} · concurrency ${f.int(bench.concurrency)}`, B, 'tok/s', `Source: ${bench.aggregate_output_tps.source || '—'} (${bench.aggregate_output_tps.as_of || '—'})`));
        cand.steps.push(S('Replicas needed for throughput', `ceil(${f.int(reqTps)} ÷ ${f.int(B)})`, repTput, 'replicas'));
        base = Math.max(repMem, repTput);
        cand.steps.push(S('Base replicas', `max(${repMem} memory, ${repTput} throughput)`, base, 'replicas'));
        const prt = v(bench.per_request_output_tps);
        cand.perReqTps = prt;
        if (typeof prt === 'number' && prt < w.target_output_tps_per_request) {
          cand.flags.push(`Benchmark per-request speed (${f.num(prt)} tok/s) is below the ${f.num(w.target_output_tps_per_request)} tok/s target — more replicas will not fix latency.`);
        }
        if (bench.concurrency && bench.concurrency > Crep) {
          cand.flags.push(`Benchmark ran at concurrency ${bench.concurrency}, above the ${Crep} that fits in memory under your KV sizing — its throughput may not be reachable.`);
        }
        if (bench.input_len && bench.output_len && (Math.abs(bench.input_len - w.avg_input_tokens) / w.avg_input_tokens > 0.5 || Math.abs(bench.output_len - w.avg_output_tokens) / w.avg_output_tokens > 0.5)) {
          cand.flags.push('Benchmark sequence lengths differ from your workload by more than 50% — throughput may not transfer.');
        }
      } else if (useTheory) {
        cand.basis = 'theoretical';
        const bw = v(gpu.mem_bandwidth_tbps);
        const tf = tflopsFor(gpu, w.precision);
        const tflops = v(tf.tflops);
        const BW = tp * bw * 1e12 * bwEff;
        const F = tp * tflops * 1e12 * cEff;
        const inOut = w.avg_input_tokens / Math.max(w.avg_output_tokens, 1);
        const stepTime = c => {
          const wRead = Math.min(Wgb, WactGb * c) * 1e9;
          const tMem = (wRead + c * kvAvgRead.bytes) / BW;
          const tComp = (c * (1 + inOut) * 2 * Pact * 1e9) / F;
          return { tMem, tComp, t: Math.max(tMem, tComp), wRead };
        };
        // Largest per-replica concurrency that still meets the per-request speed target.
        let lo = 0, hi = Crep;
        while (lo < hi) {
          const mid = Math.floor((lo + hi + 1) / 2);
          if (1 / stepTime(mid).t >= w.target_output_tps_per_request) lo = mid; else hi = mid - 1;
        }
        let cStar = lo;
        if (cStar < 1) {
          cStar = 1;
          cand.flags.push(`Even one request cannot reach ${f.num(w.target_output_tps_per_request)} tok/s on this layout (theoretical ${f.num(1 / stepTime(1).t, 1)} tok/s). Consider a larger TP size or faster GPU.`);
        }
        const st = stepTime(cStar);
        const B = cStar / st.t;
        cand.aggTps = B;
        cand.perReqTps = 1 / st.t;
        cand.cStar = cStar;
        cand.steps.push(S('THEORETICAL estimate — decode bandwidth', `${tp} GPU × ${f.num(bw)} TB/s × ${f.num(bwEff * 100)}% efficiency`, BW / 1e12, 'TB/s',
          'Not a benchmark. Roofline upper bound from memory bandwidth; ignores TP communication, scheduler overhead and kernel quality.'));
        cand.steps.push(S('THEORETICAL estimate — compute', `${tp} GPU × ${f.num(tflops)} dense ${tf.which} TFLOPS × ${f.num(cEff * 100)}% MFU`, F / 1e12, 'TFLOPS', tf.note || ''));
        cand.steps.push(S('THEORETICAL — decode step time at concurrency c',
          `max( [min(${f.num(Wgb)}, ${f.num(WactGb)}×c) GB weights + c × ${f.bytes(kvAvgRead.bytes)} KV] ÷ bandwidth , c × (1 + ${f.num(inOut, 2)} in/out) × 2 × ${f.num(Pact)}B active params ÷ compute )`,
          st.t * 1000, 'ms', 'Prefill FLOPs are amortized across output tokens. MoE weights read are approximated as min(total, active × c).'));
        cand.steps.push(S('THEORETICAL — max concurrency per replica meeting the speed target', `largest c ≤ ${Crep} with 1 ÷ step time ≥ ${f.num(w.target_output_tps_per_request)} tok/s`, cStar, 'requests'));
        cand.steps.push(S('THEORETICAL — aggregate output tok/s per replica', `${cStar} ÷ ${f.num(st.t * 1000, 2)} ms`, B, 'tok/s', `Per-request ${f.num(1 / st.t, 1)} tok/s. ${st.tComp > st.tMem ? 'Compute-bound' : 'Bandwidth-bound'} at this concurrency.`));
        const repTput = Math.ceil(reqTps / B);
        const repConc = Math.ceil(w.peak_concurrent_requests / cStar);
        cand.steps.push(S('Replicas needed for throughput', `ceil(${f.int(reqTps)} ÷ ${f.int(B)})`, repTput, 'replicas'));
        cand.steps.push(S('Replicas needed for per-request speed', `ceil(${f.int(w.peak_concurrent_requests)} ÷ ${cStar})`, repConc, 'replicas'));
        base = Math.max(repMem, repTput, repConc);
        cand.steps.push(S('Base replicas', `max(${repMem} memory, ${repTput} throughput, ${repConc} speed)`, base, 'replicas'));
      } else {
        cand.feasible = false;
        cand.reason = 'No matching benchmark (throughput source is "benchmark only")';
        return cand;
      }

      const h = w.headroom_pct / 100;
      let replicas = Math.ceil(base * (1 + h));
      let rFormula = `ceil(${base} × (1 + ${f.num(w.headroom_pct)}% headroom))`;
      if (w.n_plus_one) { replicas += 1; rFormula += ' + 1 (N+1)'; }
      cand.replicas = replicas;
      cand.steps.push(S('Replicas incl. headroom', rFormula, replicas, 'replicas'));

      let nodes;
      if (pp === 1) {
        const rpn = Math.floor(gpn / tp);
        nodes = Math.ceil(replicas / rpn);
        cand.steps.push(S('Nodes', `ceil(${replicas} replicas ÷ floor(${gpn} GPUs/node ÷ TP ${tp}) = ${rpn} replicas/node) — a replica never spans nodes`, nodes, 'nodes'));
      } else {
        nodes = replicas * pp;
        cand.steps.push(S('Nodes', `${replicas} replicas × ${pp} nodes each (pipeline parallel across nodes)`, nodes, 'nodes',
          'Pipeline parallelism across nodes needs a high-speed inter-node fabric; throughput estimate does not credit pipelining.'));
        cand.flags.push(`Model does not fit in one ${gpn}-GPU node; uses ${pp}-way pipeline parallelism across nodes.`);
      }
      cand.nodes = nodes;
      cand.gpus = nodes * gpn;
      cand.steps.push(S('Total GPUs installed', `${nodes} nodes × ${gpn} GPUs/node`, cand.gpus, 'GPUs', `${replicas * g} GPUs actively used by replicas.`));
      cand.feasible = true;
      return cand;
    });

    // Prefer layouts backed by a measured benchmark over theoretical-only ones.
    let feasible = candidates.filter(c => c.feasible);
    if (feasible.some(c => c.basis === 'benchmark')) feasible = feasible.filter(c => c.basis === 'benchmark');
    let best = null;
    feasible.forEach(c => {
      if (!best || c.nodes < best.nodes || (c.nodes === best.nodes && (c.perReqTps || 0) > (best.perReqTps || 0))) best = c;
    });
    let reason = '';
    if (!best) {
      reason = candidates.length === 0
        ? `No valid tensor-parallel size: ${v(model.attention_heads)} attention heads, ${gpn} GPUs/node`
        : candidates.map(c => `TP${c.tp}${c.pp > 1 ? '×PP' + c.pp : ''}: ${c.reason}`).join('; ');
    }
    if (w.avg_input_tokens / Math.max(w.avg_output_tokens, 1) > v(a.throughput.prefill_warning_ratio)) {
      flags.push(`Input:output ratio is ${f.num(w.avg_input_tokens / w.avg_output_tokens, 1)}:1 — prefill dominates. Decode-only benchmarks will undersize; the theoretical estimate includes prefill FLOPs but not time-to-first-token targets.`);
    }
    return { feasible: !!best, reason, best, candidates, shared, prov, flags };
  };

  // ------------------------------------------------------------------ cost
  TC.onpremCost = function ({ sizing, server, gpu, w, wl, a }) {
    const prov = new TC.Provenance();
    const A = a.onprem;
    const P = a.power;
    const years = w.term_years, months = 12 * years;
    const c = sizing.best;
    const nodes = c.nodes, gpus = c.gpus;
    const steps = [];

    let nodePrice;
    if (server.price_mode === 'base_plus_gpus') {
      const base = prov.use(`${server.vendor} ${server.sku} base price`, server.base_price_usd);
      const gp = prov.use(`${gpu.name} street price`, gpu.street_price_usd);
      nodePrice = base + server.gpus_per_node * gp;
      steps.push(S('Price per node', `${f.usd(base)} base + ${server.gpus_per_node} × ${f.usd(gp)} GPU`, nodePrice, 'USD'));
    } else {
      nodePrice = prov.use(`${server.vendor} ${server.sku} price (all-in)`, server.price_usd);
      steps.push(S('Price per node (all-in)', `${server.vendor} ${server.sku}`, nodePrice, 'USD'));
    }
    const capexServers = nodes * nodePrice;
    steps.push(S('Server capex', `${nodes} nodes × ${f.usd(nodePrice)}`, capexServers, 'USD'));

    let net;
    if (A.net_storage_mode === 'per_node') {
      const per = prov.use('Networking/storage per node', A.net_storage_usd_per_node);
      net = nodes * per;
      steps.push(S('Networking & storage allowance', `${nodes} × ${f.usd(per)}`, net, 'USD'));
    } else {
      const pct = prov.use('Networking/storage % of servers', A.net_storage_pct_of_servers);
      net = capexServers * pct / 100;
      steps.push(S('Networking & storage allowance', `${f.usd(capexServers)} × ${f.num(pct)}%`, net, 'USD'));
    }
    const installPer = prov.use('Install per node', A.install_usd_per_node);
    const install = nodes * installPer;
    if (install) steps.push(S('Install / integration', `${nodes} × ${f.usd(installPer)}`, install, 'USD'));
    const capex = capexServers + net + install;
    steps.push(S('Total capex', 'servers + networking/storage + install', capex, 'USD'));

    const rate = prov.use('Financing rate %/yr', A.financing_rate_pct_per_year) / 100;
    let financing = 0;
    if (rate > 0) {
      const r = rate / 12;
      const factor = (r * months) / (1 - Math.pow(1 + r, -months));
      financing = capex * factor - capex;
      steps.push(S('Financing cost', `${f.usd(capex)} × [r·n ÷ (1 − (1+r)^−n) − 1], r = ${f.num(rate * 100)}%/12, n = ${months}`, financing, 'USD'));
    }

    const supPct = prov.use('Support % per year', A.support_pct_per_year);
    const support = capexServers * supPct / 100 * years;
    steps.push(S('Support', `${f.usd(capexServers)} × ${f.num(supPct)}%/yr × ${years} yr`, support, 'USD'));

    const nodeKw = prov.use(`${server.vendor} ${server.sku} node power (kW)`, server.power_kw);
    const kwTotal = nodes * nodeKw;
    const load = prov.use('Load factor %', P.load_factor_pct) / 100;
    const pue = prov.use('PUE', P.pue);
    const kwh = prov.use('Electricity $/kWh', P.electricity_usd_per_kwh);
    let power = kwTotal * load * pue * 8760 * years * kwh;
    const coloIncl = A.colo_enabled && A.colo_includes_power;
    if (coloIncl) {
      power = 0;
      steps.push(S('Power', 'included in colocation rate', 0, 'USD'));
    } else {
      steps.push(S('Power', `${nodes} × ${f.num(nodeKw)} kW × ${f.num(load * 100)}% load × ${f.num(pue)} PUE × 8,760 h × ${years} yr × $${f.num(kwh, 3)}/kWh`, power, 'USD'));
    }

    let colo = 0;
    if (A.colo_enabled) {
      const cr = prov.use('Colo $/kW-month', A.colo_usd_per_kw_month);
      const kpr = prov.use('kW per rack', A.kw_per_rack);
      colo = kwTotal * cr * months;
      const racks = Math.ceil(kwTotal / kpr);
      steps.push(S('Rack / colocation', `${f.num(kwTotal)} kW nameplate × $${f.num(cr)}/kW-mo × ${months} mo`, colo, 'USD', `≈ ${racks} rack(s) at ${f.num(kpr)} kW/rack.`));
    }

    const sw = prov.use('Software $/GPU/yr', A.software_usd_per_gpu_per_year);
    const software = gpus * sw * years;
    if (software) steps.push(S('Software subscriptions', `${gpus} GPUs × ${f.usd(sw)} × ${years} yr`, software, 'USD'));
    const fte = prov.use('Ops FTE', A.ops_fte);
    const fteCost = prov.use('FTE cost/yr', A.ops_fte_cost_usd_per_year);
    const ops = fte * fteCost * years;
    if (ops) steps.push(S('Operations staff', `${f.num(fte)} FTE × ${f.usd(fteCost)} × ${years} yr`, ops, 'USD'));
    const resPct = prov.use('Residual value %', A.residual_value_pct);
    const residual = -capexServers * resPct / 100;
    if (residual) steps.push(S('Residual value credit', `−${f.usd(capexServers)} × ${f.num(resPct)}%`, residual, 'USD'));

    const total = capex + financing + support + power + colo + software + ops + residual;
    steps.push(S('Total cost over term', 'capex + financing + support + power + colo + software + ops − residual', total, 'USD'));
    const monthly = total / months;
    steps.push(S('Monthly equivalent', `${f.usd(total)} ÷ ${months} months (straight-line)`, monthly, 'USD/mo'));
    const perM = total / (wl.tTerm / 1e6);
    steps.push(S('$ per million tokens', `${f.usd(total)} ÷ ${f.tokens(wl.tTerm)} tokens over term × 1M`, perM, 'USD/M'));

    return { total, monthly, perM, capex, nodes, gpus, steps, prov, breakdown: { capexServers, net, install, financing, support, power, colo, software, ops, residual } };
  };

  /** Runs sizing + cost for every server SKU. */
  TC.runOnPrem = function (data, w, wl) {
    const model = data.models.models.find(m => m.id === w.model_id);
    const rows = [];
    if (!model || !model.self_hostable) return rows;
    const sizingCache = {};
    data.servers.servers.forEach(server => {
      const gpu = data.gpus.gpus.find(g => g.id === server.gpu_id);
      const row = { category: 'onprem', id: 'onprem:' + server.id, server, gpu, name: `${server.vendor} ${server.sku}`, sub: gpu ? gpu.name : server.gpu_id };
      if (!gpu) { row.feasible = false; row.reason = `Unknown gpu_id "${server.gpu_id}"`; rows.push(row); return; }
      const key = gpu.id + '|' + server.gpus_per_node;
      const sizing = sizingCache[key] || (sizingCache[key] = TC.sizeOnGpu({ model, gpu, gpn: server.gpus_per_node, w, a: data.assumptions, benchmarks: data.benchmarks.benchmarks }));
      row.sizing = sizing;
      if (!sizing.feasible) { row.feasible = false; row.reason = sizing.reason; rows.push(row); return; }
      const cost = TC.onpremCost({ sizing, server, gpu, w, wl, a: data.assumptions });
      Object.assign(row, { feasible: true, cost, monthly: cost.monthly, total: cost.total, perM: cost.perM });
      row.flags = [...sizing.flags, ...sizing.best.flags];
      row.basis = sizing.best.basis;
      row.placeholders = [...sizing.prov.placeholders, ...cost.prov.placeholders];
      rows.push(row);
    });
    return rows;
  };
})();
