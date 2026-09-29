/* Hybrid: own a baseline of GPU capacity, send overflow to the cheapest same-model API.
 *
 * Traffic model (per active day):
 *   hourly share of daily requests follows a bell curve around midday whose busiest hour carries
 *   the "busy-hour share" input (4.2% or less = flat 24/7). Mean concurrency in hour i:
 *     c_i = requests/day × share_i ÷ 3,600 × seconds per request.
 *   Within an hour, in-flight requests vary randomly (Poisson with mean c_i). Owned capacity K
 *   serves E[min(X, K)]; the rest overflows to the API.
 * For each candidate K (0–100% of peak, 5% steps) the cheapest server configuration sized for K
 * (no extra headroom — overflow absorbs spikes) is costed, plus API cost for the overflow tokens.
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
      const wk = TC.effectiveWorkload(Object.assign({}, w, { peak_concurrency_mode: 'manual', peak_concurrent_requests: K, headroom_pct: 0 }));
      const row = cheapest(TC.runOnPrem(data, wk, wl));
      if (!row) continue;
      const cap = TC.utilization(row.sizing.best, row.server.gpus_per_node, wl).capacity / Math.max(w.target_output_tps_per_request, 1e-9);
      const served = hourly.reduce((a, c) => a + c * TC.servedFraction(c, cap), 0);
      const share = demand > 0 ? served / demand : 1;
      const apiMonthly = api.monthly * (1 - share);
      points.push({ pct: step * 5, K, capacity: cap, share, ownedMonthly: row.monthly, apiMonthly, total: row.monthly + apiMonthly, row });
    }
    const best = points.reduce((a, p) => (p.total < a.total ? p : a), points[0]);
    const pureBest = Math.min(api.monthly, onOnly.monthly);
    const mixed = best.share > 0.05 && best.share < 0.95;
    const wins = mixed && best.total < 0.95 * pureBest;

    const steps = [
      S('Traffic curve', `busiest hour carries ${f.num(busy * 100, 1)}% of daily requests; the other hours follow a bell curve around midday${busy <= 1 / 24 + 1e-9 ? ' (flat, 24/7)' : ''}`, Math.max(...hourly), 'requests', 'Peak-hour mean concurrency; bursts within each hour are modelled as random (Poisson) arrivals.'),
      S('Owned capacity tried', '0% to 100% of peak concurrency in 5% steps, cheapest server layout for each (no extra headroom — overflow absorbs spikes)', points.length - 1, 'options'),
      S('Tokens served on owned GPUs', 'Σ hours: mean concurrency × E[min(demand, capacity)] ÷ total demand', best.share * 100, '%'),
      S('Overflow API cost', `${f.usd(api.monthly)} all-API monthly × (1 − ${f.num(best.share * 100, 1)}%) via ${api.name}`, best.apiMonthly, 'USD/mo'),
      S('Owned baseline cost', best.row ? `${best.row.name} · ${best.row.cost.nodes} node(s), ${best.row.cost.gpus} GPUs` : 'none', best.ownedMonthly, 'USD/mo'),
      S('Hybrid total', 'owned baseline + API overflow', best.total, 'USD/mo'),
    ];

    return {
      points, best, api, onOnly, wins, mixed, peak,
      apiOnly: api.monthly, onPremOnly: onOnly.monthly,
      savingsVsApi: api.monthly - best.total, savingsVsOnPrem: onOnly.monthly - best.total,
      steps,
    };
  };
})();
