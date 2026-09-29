/* Executive summary: best option per category (with low–high ranges), breakeven multiple,
   economic-fit verdict, the "why" sentence, and a confidence rating. Used by the Compare tab and the deck. */
(function () {
  const TC = window.TC;
  const f = TC.fmt;
  const v = TC.v;

  const cheapest = rows => rows.filter(r => r.feasible && isFinite(r.monthly)).sort((a, b) => a.monthly - b.monthly)[0] || null;

  /** Pure verdict rule (unit-tested). multiple = breakeven volume ÷ today's volume (0 = already cheaper, Infinity = not in range). */
  TC.fitVerdict = function ({ onMonthly, altMonthly, multiple, onHigh, hybridWins }) {
    if (onMonthly == null || altMonthly == null) return { key: 'unknown', label: 'Not enough data', tone: 'neutral' };
    if (hybridWins) return { key: 'hybrid', label: 'Hybrid candidate', tone: 'mid' };
    if (onMonthly <= altMonthly || multiple === 0) {
      // Cheaper at the central estimate, but the pessimistic case isn't: not a clear win yet.
      if (onHigh != null && onHigh > altMonthly) return { key: 'onprem-likely', label: 'Likely on-prem candidate', tone: 'mid' };
      return { key: 'onprem', label: 'Strong on-prem candidate', tone: 'good' };
    }
    if (multiple <= 3) return { key: 'near', label: 'Near breakeven', tone: 'mid' };
    return { key: 'api', label: 'API / cloud candidate', tone: 'cool' };
  };

  /** Low/high cases: optimistic vs pessimistic values for the uncertain inputs (throughput efficiency, placeholder prices, load). */
  function variants(data) {
    const mk = (bw, mfu, priceMult, load) => {
      const d = TC.clone(data);
      d.assumptions.throughput.roofline_bandwidth_efficiency_pct.value = bw;
      d.assumptions.throughput.roofline_compute_efficiency_pct.value = mfu;
      if (d.assumptions.power.load_factor_pct.status === 'placeholder') d.assumptions.power.load_factor_pct.value = load;
      d.servers.servers.forEach(s => { if (s.price_usd && s.price_usd.status === 'placeholder') s.price_usd.value *= priceMult; });
      return d;
    };
    return { low: mk(85, 55, 0.85, 60), high: mk(55, 30, 1.2, 85) };
  }

  TC.execSummary = function (data, w, res) {
    const wl = res.wl;
    const on = cheapest(res.onprem), cl = cheapest(res.cloud);
    const api = cheapest(res.api.filter(r => r.sameModel)), closed = cheapest(res.api.filter(r => !r.sameModel));

    // Ranges (only the owned/rented options carry throughput and placeholder uncertainty; API prices are list prices).
    const V = variants(data);
    const lo = TC.computeAll(V.low, w), hi = TC.computeAll(V.high, w);
    const range = (pick, base) => {
      if (!base) return null;
      const a = cheapest(pick(lo)), b = cheapest(pick(hi));
      const vals = [base.monthly, a && a.monthly, b && b.monthly].filter(x => x != null && isFinite(x));
      return { min: Math.min(...vals), max: Math.max(...vals) };
    };
    const onRange = range(r => r.onprem, on);
    const clRange = range(r => r.cloud, cl);

    // Breakeven vs the same-model API (or GPU cloud if no same-model API exists).
    const altKey = api ? 'api_same' : 'cloud_reserved';
    const alt = api || cl;
    const be = TC.breakeven(data, w, { kMax: 2000, points: 32 });
    const cross = be.crossovers.find(c => c.key === altKey);
    let multiple = Infinity;
    if (on && alt && on.monthly <= alt.monthly) multiple = 0;
    else if (cross && cross.index === 0) multiple = 0;
    else if (cross && cross.index > 0) multiple = cross.tokensMonth / wl.tMo;
    let hy = null;
    try { hy = TC.hybrid(data, w, res); } catch (e) { console.error(e); }
    const verdict = TC.fitVerdict({ onMonthly: on && on.monthly, altMonthly: alt && alt.monthly, multiple, onHigh: onRange && onRange.max, hybridWins: !!(hy && hy.wins) });

    // Why
    const util = on ? on.util * 100 : null;
    const bursty = wl.avgConc24h > 0 ? w.peak_concurrent_requests / wl.avgConc24h : null;
    const altName = api ? 'paying per token' : 'renting GPUs';
    let why = '';
    if (verdict.key === 'onprem' || verdict.key === 'onprem-likely') {
      why = `The workload keeps dedicated GPUs busy enough (about ${f.num(util, 0)}% average utilization) that owning them costs less than ${altName} at today's volume.`;
      if (verdict.key === 'onprem-likely') why += ` The pessimistic end of the on-prem range is above the ${api ? 'API' : 'cloud'} cost, so confirm server pricing and measured throughput before relying on it.`;
    } else if (verdict.key === 'hybrid') {
      const b = hy.best;
      why = `Owning a baseline sized for about ${b.pct}% of peak demand would handle ${f.num(b.share * 100, 0)}% of tokens, with the busy-hour overflow sent to ${hy.api.name}. That mix saves about ${f.usdCompact(hy.savingsVsApi * 12)}/yr versus paying per token for everything`
        + (hy.savingsVsOnPrem > 0 ? ` and ${f.usdCompact(hy.savingsVsOnPrem * 12)}/yr versus owning capacity for the full peak.` : '.');
    } else if (verdict.key === 'near') {
      why = `Owned GPUs would be about ${f.num(util, 0)}% busy today, and costs cross over at roughly ${f.num(multiple, 1)}× current usage — worth revisiting as usage grows.`;
    } else if (verdict.key === 'api') {
      why = `Dedicated GPUs would sit mostly idle (about ${f.num(util, util < 1 ? 1 : 0)}% average utilization)`
        + (bursty && bursty > 4 ? ' because capacity has to cover the busy hour but is paid for around the clock' : '')
        + `, so ${altName} costs less ` + (isFinite(multiple) ? `until usage grows about ${f.num(multiple, multiple < 10 ? 1 : 0)}×.` : 'across the whole range modeled (up to 2,000× today).');
    }

    // Confidence
    const checks = [];
    const ok = (label, detail) => checks.push({ ok: true, label, detail });
    const warn = (label, detail) => checks.push({ ok: false, label, detail });
    let uncertain = 0;
    if (on) {
      const b = on.sizing.best;
      if (b.basis === 'benchmark') ok('Throughput', b.lab ? 'Pellera lab benchmark' : 'measured benchmark');
      else { warn('Throughput', 'theoretical estimate (optimistic)'); uncertain++; }
      const sp = on.server.price_usd || {};
      if (sp.status === 'placeholder') { warn('Server pricing', 'placeholder — use current real-world pricing'); uncertain++; }
      else ok('Server pricing', sp.status === 'override' ? 'real-world pricing (your edit)' : 'current pricing');
    }
    const ps = TC.priceStatus;
    ok('API & GPU rental prices', ps && ps.date ? `public list prices, checked ${ps.date}` : 'public list prices');
    ok('Model architecture', 'from the published model configuration');
    const a = data.assumptions;
    const phAssump = ['power.load_factor_pct', 'onprem.support_pct_per_year', 'onprem.net_storage_pct_of_servers']
      .filter(p => { const [x, y] = p.split('.'); return a[x][y] && a[x][y].status === 'placeholder'; }).length;
    if (phAssump) warn('Operating assumptions', 'default power load, support and networking percentages');
    else ok('Operating assumptions', 'reviewed values');
    const level = uncertain === 0 ? 'High' : uncertain === 1 ? 'Medium' : 'Low';

    return {
      on, cl, api, closed, onRange, clRange, multiple, verdict, why, checks, level, hybrid: hy,
      breakevenTokens: isFinite(multiple) && multiple > 0 ? multiple * wl.tMo : null,
      altLabel: api ? 'paying per token for the same model' : 'renting GPUs',
    };
  };

  /** "$1.2M–$1.6M" style range, per year. */
  TC.fmtRangeYear = (r, point) => {
    if (!r) return f.usdCompact(point * 12);
    const a = r.min * 12, b = r.max * 12;
    return Math.abs(b - a) / Math.max(a, 1) < 0.03 ? f.usdCompact(a) : `${f.usdCompact(a)}–${f.usdCompact(b)}`;
  };
})();
