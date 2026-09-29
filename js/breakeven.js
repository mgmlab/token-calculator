/* Runs all engines, and sweeps workload scale to find where on-prem becomes cheaper. */
(function () {
  const TC = window.TC;

  TC.computeAll = function (data, wIn) {
    const w = TC.effectiveWorkload(wIn);
    const wl = TC.workload(w);
    return {
      w,
      wl,
      onprem: TC.excl.filterRows(TC.runOnPrem(data, w, wl)),
      cloud: TC.excl.filterRows(TC.runCloud(data, w, wl)),
      api: TC.excl.filterRows(TC.runApi(data, w, wl)),
    };
  };

  // short = legend/tooltip name; vs = how it reads in "owning servers vs …" sentences.
  TC.SERIES = [
    { key: 'onprem', label: 'Buy servers (on-prem)', vs: 'owning servers', pick: r => r.onprem },
    { key: 'cloud_reserved', label: 'Rent GPUs — reserved', vs: 'renting reserved GPUs', pick: r => r.cloud.filter(x => x.category === 'cloud_reserved') },
    { key: 'cloud_ondemand', label: 'Rent GPUs — on-demand', vs: 'renting on-demand GPUs', pick: r => r.cloud.filter(x => x.category === 'cloud_ondemand') },
    { key: 'api_same', label: 'Pay per token — same model', vs: 'paying per token for the same model', pick: r => r.api.filter(x => x.sameModel) },
    { key: 'api_closed', label: 'Pay per token — other models', vs: 'paying per token for other models (GPT, Claude, Gemini…)', pick: r => r.api.filter(x => !x.sameModel) },
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
      // Derived peak is recomputed from the scaled volume (smoothing); a manual peak scales linearly.
      const wk = Object.assign({}, w, { users: w.users * k });
      if (w.peak_concurrency_mode !== 'derived') wk.peak_concurrent_requests = Math.max(1, Math.ceil(w.peak_concurrent_requests * k));
      const r = TC.computeAll(data, wk);
      const p = { k, tokensMonth: r.wl.tMo, peak: r.w.peak_concurrent_requests, series: {} };
      TC.SERIES.forEach(s => {
        const b = cheapest(s.pick(r));
        p.series[s.key] = b ? { monthly: b.monthly, name: b.name, sub: b.sub, util: b.util } : null;
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
      return { key: s.key, label: s.label, vs: s.vs, index: idx, hasData, tokensMonth: idx > 0 ? pts[idx].tokensMonth : null, text };
    });

    return { points: pts, crossovers, currentTokens: TC.workload(TC.effectiveWorkload(w)).tMo };
  };
})();
