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
    { key: 'api_closed', label: 'Pay per token — closed models', vs: 'paying per token for closed models (GPT, Claude, Gemini…)', pick: r => r.api.filter(x => !x.sameModel) },
  ];

  function cheapest(rows) {
    let best = null;
    rows.forEach(r => { if (r.feasible && isFinite(r.monthly) && (!best || r.monthly < best.monthly)) best = r; });
    return best;
  }

  /**
   * Yearly cost of each architecture at several usage levels (multiples of today), using the same rules as the
   * Analysis summary: right-sized on-prem when it applies, and the hybrid only when it wins.
   */
  TC.breakevenTable = function (data, w, mults) {
    const cheap = rows => rows.filter(r => r.feasible && isFinite(r.monthly)).sort((a, b) => a.monthly - b.monthly)[0] || null;
    return (mults || [0.25, 0.5, 1, 2, 5, 10, 25, 50]).map(k => {
      const wk = Object.assign({}, w, { users: w.users * k });
      if (w.peak_concurrency_mode !== 'derived') wk.peak_concurrent_requests = Math.max(1, Math.ceil(w.peak_concurrent_requests * k));
      const r = TC.computeAll(data, wk);
      let on = cheap(r.onprem), rightSized = false;
      let hy = null;
      try { hy = TC.hybrid(data, r.w, r); } catch (e) { hy = null; }
      if (hy && hy.rightSized && on && hy.rightSized.ownedMonthly < on.monthly) { on = { monthly: hy.rightSized.ownedMonthly }; rightSized = true; }
      const cl = cheap(r.cloud), api = cheap(r.api.filter(x => x.sameModel));
      const cells = { onprem: on && on.monthly * 12, cloud: cl && cl.monthly * 12, api: api && api.monthly * 12, hybrid: hy && hy.wins ? hy.best.total * 12 : null };
      const vals = Object.entries(cells).filter(([, v]) => v != null && isFinite(v));
      const best = vals.length ? vals.sort((a, b) => a[1] - b[1])[0][0] : null;
      return { k, tokensMonth: r.wl.tMo, cells, best, rightSized };
    });
  };

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
