/* Runs all engines, and sweeps workload scale to find where on-prem becomes cheaper. */
(function () {
  const TC = window.TC;

  TC.computeAll = function (data, w) {
    const wl = TC.workload(w);
    return {
      wl,
      onprem: TC.runOnPrem(data, w, wl),
      cloud: TC.runCloud(data, w, wl),
      api: TC.runApi(data, w, wl),
    };
  };

  TC.SERIES = [
    { key: 'onprem', label: 'On-prem (cheapest SKU)', pick: r => r.onprem },
    { key: 'cloud_reserved', label: 'GPU cloud reserved (cheapest)', pick: r => r.cloud.filter(x => x.category === 'cloud_reserved') },
    { key: 'cloud_ondemand', label: 'GPU cloud on-demand (cheapest)', pick: r => r.cloud.filter(x => x.category === 'cloud_ondemand') },
    { key: 'api_same', label: 'API, same model (cheapest)', pick: r => r.api.filter(x => x.sameModel) },
    { key: 'api_closed', label: 'API, closed reference (cheapest)', pick: r => r.api.filter(x => !x.sameModel) },
  ];

  function cheapest(rows) {
    let best = null;
    rows.forEach(r => { if (r.feasible && isFinite(r.monthly) && (!best || r.monthly < best.monthly)) best = r; });
    return best;
  }

  /**
   * Scales users and peak concurrency together by k (log-spaced), keeping per-request
   * shape constant, and records the cheapest option per category at each point.
   */
  TC.breakeven = function (data, w, opts) {
    const o = Object.assign({ kMin: 0.02, kMax: 50, points: 80 }, opts || {});
    const pts = [];
    for (let i = 0; i < o.points; i++) {
      const k = o.kMin * Math.pow(o.kMax / o.kMin, i / (o.points - 1));
      const wk = Object.assign({}, w, {
        users: w.users * k,
        peak_concurrent_requests: Math.max(1, Math.ceil(w.peak_concurrent_requests * k)),
      });
      const r = TC.computeAll(data, wk);
      const p = { k, tokensMonth: r.wl.tMo, series: {} };
      TC.SERIES.forEach(s => {
        const b = cheapest(s.pick(r));
        p.series[s.key] = b ? { monthly: b.monthly, name: b.name, sub: b.sub } : null;
      });
      pts.push(p);
    }

    // Smallest volume above which on-prem stays at or below the other series for the rest of the range.
    const crossovers = TC.SERIES.filter(s => s.key !== 'onprem').map(s => {
      let idx = -1;
      for (let i = pts.length - 1; i >= 0; i--) {
        const a = pts[i].series.onprem, b = pts[i].series[s.key];
        if (!a || !b) { if (!b) continue; break; }
        if (a.monthly <= b.monthly) idx = i; else break;
      }
      const hasData = pts.some(p => p.series[s.key]) && pts.some(p => p.series.onprem);
      let text;
      if (!hasData) text = 'no data for one of the two options';
      else if (idx === -1) text = `on-prem is still more expensive at the top of the range (${TC.fmt.tokens(pts[pts.length - 1].tokensMonth)} tokens/month)`;
      else if (idx === 0) text = `on-prem is cheaper across the whole range (from ${TC.fmt.tokens(pts[0].tokensMonth)} tokens/month)`;
      else text = `on-prem becomes cheaper above ≈ ${TC.fmt.tokens(pts[idx].tokensMonth)} tokens/month`;
      return { key: s.key, label: s.label, index: idx, tokensMonth: idx > 0 ? pts[idx].tokensMonth : null, text };
    });

    return { points: pts, crossovers, currentTokens: TC.workload(w).tMo };
  };
})();
