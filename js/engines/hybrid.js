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

  const cheapest = rows => rows.filter(r => r.feasible && isFinite(r.monthly)).sort((a, b) => a.monthly - b.monthly)[0] || null;

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

    const points = [{ pct: 0, K: 0, share: 0, ownedMonthly: 0, apiMonthly: api.monthly, total: api.monthly, row: null }];
    const seen = new Set();
    for (let step = 1; step <= 20; step++) {
      const K = Math.max(1, Math.round(peak * step / 20));
      if (seen.has(K)) continue;
      seen.add(K);
      const wk = TC.effectiveWorkload(Object.assign({}, w, { peak_concurrency_mode: 'manual', peak_concurrent_requests: K }));
      const onRows = TC.runOnPrem(data, wk, wl);
      const row = cheapest(onRows);
      if (!row) continue;
      // Requests the owned setup can carry at once: limited by throughput (at the target speed) AND by GPU memory
      // for each request's KV cache (model copies × max concurrent per copy) — the same memory limit on-prem sizing uses.
      const c = row.sizing.best;
      const activeNodes = c.nodes - (c.spareNodes || 0); // the N+1 spare server is standby, not serving capacity
      const slots = c.pp === 1 ? Math.floor(row.server.gpus_per_node / c.tp) * activeNodes : c.replicas;
      const capTput = TC.utilization(c, row.server.gpus_per_node, wl).capacity / Math.max(w.target_output_tps_per_request, 1e-9);
      const capMem = c.Crep > 0 ? slots * c.Crep : Infinity;
      const cap = Math.min(capTput, capMem);
      const served = hourly.reduce((a, c) => a + c * TC.servedFraction(c, cap), 0);
      const share = demand > 0 ? served / demand : 1;
      const apiMonthly = api.monthly * (1 - share);
      points.push({ pct: step * 5, K, capacity: cap, share, ownedMonthly: row.monthly, apiMonthly, total: row.monthly + apiMonthly, row, setup: TC.describeOnPrem(onRows, row).label });
    }
    const best = points.reduce((a, p) => (p.total < a.total ? p : a), points[0]);
    // A mix only "wins" if it beats every single-architecture option, GPU cloud included.
    const pureBest = Math.min(api.monthly, onOnly.monthly, cloud ? cloud.monthly : Infinity);
    // A real hybrid owns some capacity but less than the full peak (the API takes the rest, even if that is only rare bursts).
    const mixed = !!best.row && best.pct > 0 && best.pct < 100;
    const wins = mixed && best.total < 0.95 * pureBest;

    const steps = [
      S('Traffic curve', `busiest hour carries ${f.num(busy * 100, 1)}% of daily requests; the other hours follow a bell curve around midday${busy <= 1 / 24 + 1e-9 ? ' (flat, 24/7)' : ''}`, Math.max(...hourly), 'requests', 'Peak-hour mean concurrency; bursts within each hour are modelled as random (Poisson) arrivals.'),
      S('Owned capacity tried', '0% to 100% of peak concurrency in 5% steps, cheapest server layout for each (same headroom and N+1 settings as on-prem)', points.length - 1, 'options'),
      S('Tokens served on owned GPUs', 'Σ hours: mean concurrency × E[min(demand, capacity)] ÷ total demand', best.share * 100, '%'),
      S('Overflow API cost', `${f.usd(api.monthly)} all-API monthly × (1 − ${f.num(best.share * 100, 1)}%) via ${api.name}`, best.apiMonthly, 'USD/mo'),
      S('Owned baseline cost', best.row ? `${best.setup} · ${best.row.cost.nodes} node(s)` : 'none', best.ownedMonthly, 'USD/mo'),
      S('Hybrid total', 'owned baseline + API overflow', best.total, 'USD/mo'),
    ];

    return {
      points, best, api, onOnly, cloud, wins, mixed, peak,
      apiOnly: api.monthly, onPremOnly: onOnly.monthly,
      savingsVsApi: api.monthly - best.total, savingsVsOnPrem: onOnly.monthly - best.total,
      savingsVsCloud: cloud ? cloud.monthly - best.total : null,
      steps,
    };
  };
})();
