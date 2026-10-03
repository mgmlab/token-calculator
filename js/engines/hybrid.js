/* Hybrid: own a baseline of GPU capacity, send overflow to the cheapest same-model API.
 *
 * Traffic model (per active day):
 *   hourly share of daily requests follows a bell curve around midday whose busiest hour carries
 *   the "busy-hour share" input (4.2% or less = flat 24/7). Mean concurrency in hour i:
 *     c_i = requests/day × share_i ÷ 3,600 × seconds per request.
 *   Within an hour, in-flight requests vary randomly (Poisson with mean c_i). Owned capacity K
 *   serves E[min(X, K)]; the rest overflows to the API.
 * For each candidate K (0–100% of peak, 5% steps) the cheapest server configuration sized for K
 * (its capacity is the smaller of its throughput and the requests its GPU memory can hold at once)
 * (with the same headroom and N+1 settings as on-prem, so 100% owned equals the on-prem option) is costed,
 * plus API cost for the overflow tokens.
 */
(function () {
  const TC = window.TC;
  const S = TC.step;
  const f = TC.fmt;

  /** 24 hourly shares of a day's requests; the largest equals busyShare (flat if ≤ 1/24). */
  TC.trafficProfile = function (busyShare) {
    if (!(busyShare > 1 / 24 + 1e-9)) return new Array(24).fill(1 / 24);
    const shape = sigma => {
      const raw = Array.from({ length: 24 }, (_, i) => Math.exp(-((i - 12) ** 2) / (2 * sigma * sigma)));
      const sum = raw.reduce((a, b) => a + b, 0);
      return raw.map(x => x / sum);
    };
    let lo = 0.2, hi = 60; // narrower sigma -> bigger peak share
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (Math.max(...shape(mid)) > busyShare) lo = mid; else hi = mid;
    }
    return shape((lo + hi) / 2);
  };

  function normPdf(z) { return Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI); }
  function normCdf(z) { // Abramowitz–Stegun 7.1.26
    const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
    return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
  }

  /** Share of demand served when mean concurrency is c and capacity is K: E[min(X,K)] / c, X ~ Poisson(c). */
  TC.servedFraction = function (c, K) {
    if (!(c > 0)) return 1;
    if (!(K > 0)) return 0;
    if (c >= 30) { // normal approximation
      const sd = Math.sqrt(c), z = (K - c) / sd;
      const over = sd * normPdf(z) - (K - c) * (1 - normCdf(z)); // E[(X-K)+]
      return Math.max(0, Math.min(1, (c - over) / c));
    }
    let p = Math.exp(-c), cdfBelowK = 0, sumBelowK = 0;
    const kInt = Math.floor(K);
    for (let x = 0; x < kInt; x++) {
      sumBelowK += x * p;
      cdfBelowK += p;
      p = p * c / (x + 1);
    }
    // E[min(X,K)] = Σ_{x<K} x P(x) + K · P(X ≥ K)
    return Math.max(0, Math.min(1, (sumBelowK + kInt * (1 - cdfBelowK)) / c));
  };

  /** Share of tokens as text that never rounds a near-miss up to 100% (99.97% stays 99.97%). */
  TC.fmtShare = s => {
    const v = s * 100;
    if (v >= 100 - 1e-9) return '100%';
    if (v > 99.99) return '>99.99%';
    if (v >= 99.5) return (Math.floor(v * 100) / 100).toFixed(2) + '%';
    if (v > 0 && v < 0.5) return '<1%';
    return f.num(v, 0) + '%';
  };
  /** What an owned setup actually covers, in words ("about 95% of the calculated peak"). */
  TC.capText = p => (p.capPct >= 100 ? 'the full calculated peak' : `about ${p.capPct}% of the calculated peak`);

  /**
   * The distinct ownership options the sweep found, cheapest hardware first: "none (all API)", then each
   * server setup once (several requested sizes often round up to the same servers). best = lowest total.
   */
  TC.hybridOptions = hy => {
    const seen = new Map();
    hy.points.forEach(p => {
      const key = p.row ? p.setup + '|' + Math.round(p.ownedMonthly) : 'none';
      // The same hardware shows up at several requested sizes; keep the one sized for the most load, which is what
      // those servers can really carry (smaller requests are sized, and so measured, for less concurrency).
      const prev = seen.get(key);
      if (!prev || (p.capacity || 0) > (prev.capacity || 0)) seen.set(key, p);
    });
    const opts = [...seen.values()].sort((a, b) => a.ownedMonthly - b.ownedMonthly || a.pct - b.pct);
    const rsKey = hy.rightSized ? hy.rightSized.setup + '|' + Math.round(hy.rightSized.ownedMonthly) : null;
    opts.forEach(p => { p.rightSized = !!(rsKey && p.row && p.setup + '|' + Math.round(p.ownedMonthly) === rsKey); });
    // The right-sized setup is costed as servers only (peak overflow waits), so it competes on that figure.
    const eff = p => (p.rightSized ? p.ownedMonthly : p.total);
    const lowest = opts.reduce((m, p) => (eff(p) < eff(m) ? p : m), opts[0]);
    const matchBest = p => !rsKey && p.row && hy.best.row && p.setup === hy.best.setup && Math.round(p.ownedMonthly) === Math.round(hy.best.ownedMonthly);
    return opts.map(p => Object.assign({}, p, { best: p === lowest || matchBest(p) }));
  };
  /** Short server label for charts: "2× RTX PRO 6000 Blackwell Server 96GB" without the vendor list. */
  TC.shortSetup = p => (p.row ? p.setup.replace(/\s*\([^)]*\)\s*$/, '') : 'None: all API');

  const cheapest = rows => rows.filter(r => r.feasible && isFinite(r.monthly)).sort((a, b) => a.monthly - b.monthly)[0] || null;

  /** Erlang C: probability an arrival has to wait with c servers and offered load A (A < c). Stable for large c. */
  function erlangC(c, A) {
    let B = 1;
    for (let k = 1; k <= c; k++) B = A * B / (k + A * B);
    return B / (1 - (A / c) * (1 - B));
  }
  /**
   * Waiting in the busiest hour if requests beyond capacity queue instead of going elsewhere.
   * hourly = mean concurrent requests per hour (offered load in Erlangs), s = seconds per request, capacity = concurrent slots.
   * Within an hour that fits (load < slots): M/M/c queue (random arrivals). An hour that does not fit builds a backlog
   * that carries into the next hours until load falls (fluid approximation). If the backlog never clears, waits are unbounded.
   */
  TC.peakWait = function (hourly, s, capacity) {
    const c = Math.max(1, Math.floor(capacity));
    let B = 0, endDay1 = 0, maxW = 0, startOfPeak = 0;
    const m = hourly.indexOf(Math.max(...hourly));
    for (let i = 0; i < 48; i++) {
      const A = hourly[i % 24];
      if (i >= 24 && i % 24 === m) startOfPeak = B;
      B = Math.max(0, B + (A - c) * 3600); // slot-seconds of queued work
      if (i >= 24) maxW = Math.max(maxW, B / c);
      if (i === 23) endDay1 = B;
    }
    if (B > endDay1 + 1) return { unstable: true, pWait: 1, typical: Infinity, p95: Infinity };
    const A = hourly[m], carry = startOfPeak / c;
    if (A < c) {
      const P = erlangC(c, A);
      const typical = carry + P * s / (c - A);
      const p95 = carry + (P > 0.05 ? Math.log(P / 0.05) * s / (c - A) : 0);
      return { unstable: false, pWait: carry > 0 ? 1 : P, typical, p95 };
    }
    // Over capacity for the whole busiest hour: everyone waits; the backlog grows through the hour.
    return { unstable: false, pWait: 1, typical: carry + (A - c) * 1800 / c, p95: Math.max(maxW, carry + (A - c) * 3600 / c) };
  };
  /** The acceptable-wait setting in words ("5 seconds"). */
  TC.tolText = t => ({ 5: '5 seconds', 30: '30 seconds', 120: '2 minutes', 600: '10 minutes' }[t] || `${t} seconds`);
  /** One line describing busiest-hour waiting for an owned setup, if overflow queues. */
  TC.waitText = wt => (!wt ? '' : wt.unstable ? 'backlog never clears' : wt.pWait < 0.005 ? 'no waiting' : `${Math.round(wt.pWait * 100)}% wait · 95% start within ${TC.fmtWait(wt.p95)}`);
  /** "under a second", "12 s", "3 min" */
  TC.fmtWait = t => (!isFinite(t) ? 'never clears' : t < 1 ? 'under a second' : t < 90 ? `${Math.round(t)} s` : t < 5400 ? `${Math.round(t / 60)} min` : `${f.num(t / 3600, 1)} h`);

  TC.hybrid = function (data, w, res) {
    const wl = res.wl;
    const api = cheapest(res.api.filter(r => r.sameModel));
    const onOnly = cheapest(res.onprem);
    const cloud = cheapest(res.cloud);
    if (!api || !onOnly) return null;

    const reqDay = w.users * w.requests_per_user_per_day;
    const secPerReq = w.avg_output_tokens / Math.max(w.target_output_tps_per_request, 1e-9) + 1;
    const busy = (w.busy_hour_share_pct || 15) / 100;
    const profile = TC.trafficProfile(busy);
    const hourly = profile.map(s => reqDay * s / 3600 * secPerReq);
    const demand = hourly.reduce((a, b) => a + b, 0);
    const peak = TC.effectiveWorkload(w).peak_concurrent_requests;

    // Running two paths (owned servers + an API provider) needs a gateway and someone to look after it. Applied to every
    // mix that actually routes traffic to the API; owning outright or paying per token for everything carries none.
    const ha = data.assumptions.hybrid || {};
    const setupUsd = TC.v(ha.routing_setup_usd) || 0, routingFte = TC.v(ha.routing_ops_fte) || 0;
    const fteCost = TC.v(data.assumptions.onprem.ops_fte_cost_usd_per_year) || 0;
    const routingMonthly = setupUsd / (12 * w.term_years) + routingFte * fteCost / 12;
    const points = [{ pct: 0, K: 0, share: 0, ownedMonthly: 0, apiMonthly: api.monthly, routingMonthly: 0, total: api.monthly, row: null }];
    const seen = new Set();
    for (let step = 1; step <= 20; step++) {
      const K = Math.max(1, Math.round(peak * step / 20));
      if (seen.has(K)) continue;
      seen.add(K);
      const wk = TC.effectiveWorkload(Object.assign({}, w, { peak_concurrency_mode: 'manual', peak_concurrent_requests: K }));
      const onRows = TC.runOnPrem(data, wk, wl);
      const row = cheapest(onRows);
      if (!row) continue;
      // Requests the owned setup can carry at once: limited by throughput, by per-request speed and by GPU memory
      // for each request's KV cache (model copies × max concurrent per copy) — the same memory limit on-prem sizing uses.
      const c = row.sizing.best;
      const activeNodes = c.nodes - (c.spareNodes || 0); // the N+1 spare server is standby, not serving capacity
      const slots = c.pp === 1 ? Math.floor(row.server.gpus_per_node / c.tp) * activeNodes : c.replicas;
      const capTput = TC.utilization(c, row.server.gpus_per_node, wl).capacity / Math.max(w.target_output_tps_per_request, 1e-9);
      const capMem = c.Crep > 0 ? slots * c.Crep : Infinity;
      // Same per-request speed limit on-prem sizing uses: each copy serves at most cStar requests at the target speed.
      const capSpeed = c.cStar > 0 ? slots * c.cStar : Infinity;
      // Headroom is reserve, exactly as in on-prem sizing: it is not counted as capacity for serving the peak.
      // (Otherwise a setup without its headroom would look like it "handles the full peak" and undercut on-prem.)
      const cap = Math.min(capTput, capMem, capSpeed) / (1 + (w.headroom_pct || 0) / 100);
      const served = hourly.reduce((a, c) => a + c * TC.servedFraction(c, cap), 0);
      const share = demand > 0 ? served / demand : 1;
      const apiMonthly = api.monthly * (1 - share);
      const routes = share < 1 && apiMonthly * 12 >= 1; // a mix that sends anything to the API needs the routing layer
      const rM = routes ? routingMonthly : 0;
      const wait = TC.peakWait(hourly, secPerReq, cap);
      points.push({ pct: step * 5, K, capacity: cap, capPct: Math.round(cap / Math.max(peak, 1e-9) * 100), share, wait, ownedMonthly: row.monthly, apiMonthly, routingMonthly: rM, total: row.monthly + apiMonthly + rM, row, setup: TC.describeOnPrem(onRows, row).label });
    }
    const best = points.reduce((a, p) => (p.total < a.total ? p : a), points[0]);
    // A mix only "wins" if it beats every single-architecture option, GPU cloud included.
    const pureBest = Math.min(api.monthly, onOnly.monthly, cloud ? cloud.monthly : Infinity);
    // A real hybrid owns some capacity but less than the full peak (the API takes the rest, even if that is only rare bursts).
    const mixed = !!best.row && best.pct > 0 && best.pct < 100;
    // ...and the API must carry a meaningful part of the work: a gateway and a second provider are not worth it
    // for a sliver of tokens. Below 2% of tokens (or ~$1K/yr of API spend) the mix is treated as owning outright.
    const material = (1 - best.share) >= 0.02 && best.apiMonthly * 12 >= 1000;
    const wins = mixed && material && best.total < 0.95 * pureBest;

    // Right-sized on-prem: the cheapest owned setup whose busiest-hour wait stays within what the customer accepts
    // (95% of requests start within peak_wait_s seconds), when overflow queues on the same servers instead of going elsewhere.
    // 0 = no waiting: always size for the full calculated peak. Cheaper than full-peak sizing → it is the on-prem answer.
    const tol = w.peak_wait_s == null ? 5 : Number(w.peak_wait_s);
    const rs = tol > 0 ? points.filter(p => p.row && p.wait && !p.wait.unstable && p.wait.p95 <= tol).sort((a, b) => a.ownedMonthly - b.ownedMonthly)[0] || null : null;
    const rightSized = rs && rs.ownedMonthly < onOnly.monthly * 0.995 ? rs : null;

    const steps = [
      S('Traffic curve', `busiest hour carries ${f.num(busy * 100, 1)}% of daily requests; the other hours follow a bell curve around midday${busy <= 1 / 24 + 1e-9 ? ' (flat, 24/7)' : ''}`, Math.max(...hourly), 'requests', 'Peak-hour mean concurrency; bursts within each hour are modelled as random (Poisson) arrivals.'),
      S('Owned capacity tried', '0% to 100% of peak concurrency in 5% steps, cheapest server layout for each (same headroom and N+1 settings as on-prem)', points.length - 1, 'options'),
      S('Owned capacity actually installed', best.row ? `${best.setup}: can carry ${f.int(best.capacity || 0)} concurrent requests vs ${f.int(peak)} at peak (servers come in whole units, so this is usually more than the ${best.pct}% requested)` : 'none', best.capPct || 0, '% of peak'),
      S('Tokens served on owned GPUs', 'Σ hours: mean concurrency × E[min(demand, capacity)] ÷ total demand', best.share * 100, '%'),
      S('Overflow API cost', `${f.usd(api.monthly)} all-API monthly × (1 − ${f.num(best.share * 100, 1)}%) via ${api.name}`, best.apiMonthly, 'USD/mo'),
      S('Owned baseline cost', best.row ? `${best.setup} · ${best.row.cost.nodes} node(s)` : 'none', best.ownedMonthly, 'USD/mo'),
      S('Routing setup & operations', best.routingMonthly ? `${f.usd(setupUsd)} one-time ÷ ${12 * w.term_years} months + ${f.num(routingFte, 2)} FTE × ${f.usd(fteCost)}/yr ÷ 12 (gateway and second provider)` : 'none: this mix sends nothing to the API', best.routingMonthly || 0, 'USD/mo'),
      S('Hybrid total', 'owned baseline + API overflow + routing', best.total, 'USD/mo'),
    ];

    return {
      points, best, api, onOnly, cloud, wins, mixed, material, peak, rightSized, routingMonthly, tol, secPerReq,
      apiOnly: api.monthly, onPremOnly: onOnly.monthly,
      savingsVsApi: api.monthly - best.total, savingsVsOnPrem: onOnly.monthly - best.total,
      savingsVsCloud: cloud ? cloud.monthly - best.total : null,
      steps,
    };
  };
})();
