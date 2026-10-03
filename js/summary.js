/* Executive summary: best option per category (with low–high ranges), breakeven multiple,
   economic-fit verdict, the "why" sentence, and a confidence rating. Used by the Compare tab and the deck. */
(function () {
  const TC = window.TC;
  const f = TC.fmt;
  const v = TC.v;

  const cheapest = rows => rows.filter(r => r.feasible && isFinite(r.monthly)).sort((a, b) => a.monthly - b.monthly)[0] || null;

  /**
   * Pure verdict rule (unit-tested). Picks the lowest-cost architecture among owning servers, renting GPUs,
   * paying per token (same model) and the hybrid mix. multiple = volume at which owning crosses the same-model API
   * ÷ today's volume (Infinity = not in range); it only decides "Near breakeven" when paying per token is cheapest.
   */
  TC.fitVerdict = function ({ onMonthly, apiMonthly, cloudMonthly, multiple, onHigh, hybridWins }) {
    const alts = [apiMonthly, cloudMonthly].filter(x => x != null && isFinite(x));
    if (onMonthly == null || !alts.length) return { key: 'unknown', label: 'Not enough data', tone: 'neutral' };
    if (hybridWins) return { key: 'hybrid', label: 'Hybrid candidate', tone: 'mid' };
    const alt = Math.min(...alts);
    if (onMonthly <= alt) {
      // Cheaper at the central estimate, but the pessimistic case isn't: not a clear win yet.
      if (onHigh != null && onHigh > alt) return { key: 'onprem-likely', label: 'Likely on-prem candidate', tone: 'mid' };
      return { key: 'onprem', label: 'Strong on-prem candidate', tone: 'good' };
    }
    if (cloudMonthly != null && (apiMonthly == null || cloudMonthly < apiMonthly)) return { key: 'cloud', label: 'GPU cloud candidate', tone: 'cool' };
    if (multiple <= 3) return { key: 'near', label: 'Near breakeven', tone: 'mid' };
    return { key: 'api', label: 'API candidate', tone: 'cool' };
  };

  /** The optimistic and pessimistic values behind every range (shown to users in the range breakdown). */
  TC.RANGE_CASES = {
    low: { bw: 85, mfu: 55, price: 0.85, load: 60 },
    high: { bw: 55, mfu: 30, price: 1.2, load: 85 },
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
    const L = TC.RANGE_CASES.low, H = TC.RANGE_CASES.high;
    return { low: mk(L.bw, L.mfu, L.price, L.load), high: mk(H.bw, H.mfu, H.price, H.load) };
  }

  TC.execSummary = function (data, w, res) {
    const wl = res.wl;
    let on = cheapest(res.onprem);
    const cl = cheapest(res.cloud);
    const api = cheapest(res.api.filter(r => r.sameModel)), closed = cheapest(res.api.filter(r => !r.sameModel));

    // Ranges (only the owned/rented options carry throughput and placeholder uncertainty; API prices are list prices).
    const V = variants(data);
    const lo = TC.computeAll(V.low, w), hi = TC.computeAll(V.high, w);
    let hy = null;
    try { hy = TC.hybrid(data, w, res); } catch (e) { console.error(e); }
    // A smaller owned setup that carries ≥99.5% of tokens beats buying for the full calculated peak: that is the on-prem answer.
    const rs = hy && hy.rightSized;
    let onLabel = TC.describeOnPrem(res.onprem, on).label;
    if (rs && on && rs.ownedMonthly < on.monthly) {
      on = Object.assign({}, rs.row, { rightSized: rs });
      onLabel = rs.setup;
    }
    const range = (pick, base) => {
      if (!base) return null;
      // The same option (same server or rental offer) under optimistic and pessimistic inputs, so the range
      // belongs to the option named in the box rather than to whichever option happens to be cheapest then.
      const same = rows => rows.find(r => r.id === base.id && r.feasible && isFinite(r.monthly)) || null;
      let a, b;
      if (base.rightSized) {
        // Right-sized: the same server sized for the same share of the peak, under optimistic / pessimistic inputs.
        const at = (d, x) => {
          const wk = TC.effectiveWorkload(Object.assign({}, w, { peak_concurrency_mode: 'manual', peak_concurrent_requests: base.rightSized.K }));
          return same(TC.excl.filterRows(TC.runOnPrem(d, wk, x.wl)));
        };
        a = at(V.low, lo); b = at(V.high, hi);
      } else { a = same(pick(lo)); b = same(pick(hi)); }
      const vals = [base.monthly, a && a.monthly, b && b.monthly].filter(x => x != null && isFinite(x));
      return { min: Math.min(...vals), max: Math.max(...vals), cases: { low: a, central: base, high: b } };
    };
    const onRange = range(r => r.onprem, on);
    const clRange = range(r => r.cloud, cl);

    // Breakeven: owning vs the same-model API (or GPU cloud if no same-model API exists). The verdict itself
    // compares every architecture; this multiple only feeds the breakeven sentence and "Near breakeven".
    const altKey = api ? 'api_same' : 'cloud_reserved';
    const alt = api || cl;
    const cheapAlt = [api, cl].filter(Boolean).sort((a, b) => a.monthly - b.monthly)[0] || null;
    const be = TC.breakeven(data, w, { kMax: 2000, points: 32 });
    const cross = be.crossovers.find(c => c.key === altKey);
    let multiple = Infinity;
    if (on && alt && on.monthly <= alt.monthly) multiple = 0;
    else if (cross && cross.index === 0) multiple = 0;
    else if (cross && cross.index > 0) multiple = cross.tokensMonth / wl.tMo;
    let verdict = TC.fitVerdict({ onMonthly: on && on.monthly, apiMonthly: api && api.monthly, cloudMonthly: cl && cl.monthly, multiple, onHigh: onRange && onRange.max, hybridWins: !!(hy && hy.wins) });

    // Why
    const util = on ? on.util * 100 : null;
    const bursty = wl.avgConc24h > 0 ? w.peak_concurrent_requests / wl.avgConc24h : null;
    const altName = cheapAlt === cl ? 'renting GPUs' : 'paying per token';
    let why = '';
    if ((verdict.key === 'onprem' || verdict.key === 'onprem-likely') && on.rightSized) {
      const r = on.rightSized;
      why = `One right-sized setup (${r.setup}) carries ${TC.fmtShare(r.share)} of tokens on its own: it covers ${TC.capText(r)} with headroom, so there is no need to buy extra servers for the full peak (${f.usdCompact((hy.onPremOnly - r.ownedMonthly) * 12)}/yr more). In the rare busiest minutes the remaining ${TC.fmtShare(1 - r.share)} can wait a few seconds, or spill to ${hy.api.name} for about ${f.usdCompact(r.apiMonthly * 12)}/yr if an API fallback is already in place. Owning it costs ${f.usdCompact((cheapAlt.monthly - r.ownedMonthly) * 12)}/yr less than ${altName}.`;
      if (verdict.key === 'onprem-likely') why += ` The pessimistic end of the on-prem range is above the ${cheapAlt === cl ? 'GPU cloud' : 'API'} cost, so current server pricing and a measured benchmark would make this call firmer.`;
    } else if (verdict.key === 'onprem' || verdict.key === 'onprem-likely') {
      why = `The workload keeps dedicated GPUs busy enough (about ${f.num(util, 0)}% average utilization) that owning them costs less than ${altName} at today's volume.`;
      if (verdict.key === 'onprem-likely') why += ` The pessimistic end of the on-prem range is above the ${cheapAlt === cl ? 'GPU cloud' : 'API'} cost, so current server pricing and a measured benchmark would make this call firmer.`;
    } else if (verdict.key === 'hybrid') {
      const b = hy.best;
      why = `Owning a baseline that covers ${TC.capText(b)} (${b.setup}) would handle ${TC.fmtShare(b.share)} of tokens, with the busy-hour overflow sent to ${hy.api.name}. That mix saves about ${f.usdCompact(hy.savingsVsApi * 12)}/yr versus paying per token for everything`
        + (hy.savingsVsOnPrem > 0 ? ` and ${f.usdCompact(hy.savingsVsOnPrem * 12)}/yr versus owning capacity for the full peak.` : '.');
    } else if (verdict.key === 'cloud') {
      why = `Renting GPUs (${cl.name}, ${cl.pricing.toLowerCase()}) is the lowest-cost option: about ${f.usdCompact((on.monthly - cl.monthly) * 12)}/yr less than owning servers`
        + (api ? ` and ${f.usdCompact((api.monthly - cl.monthly) * 12)}/yr less than paying per token for the same model.` : '.')
        + ' Rented capacity avoids the upfront purchase while still running the model on dedicated GPUs.';
    } else if (verdict.key === 'near') {
      why = `Owned GPUs would be about ${f.num(util, 0)}% busy today, and costs cross over at roughly ${f.num(multiple, 1)}× current usage — worth revisiting as usage grows.`;
    } else if (verdict.key === 'api') {
      why = `Dedicated GPUs would sit mostly idle (about ${f.num(util, util < 1 ? 1 : 0)}% average utilization)`
        + (bursty && bursty > 4 ? ' because capacity has to cover the busy hour but is paid for around the clock' : '')
        + `, so paying per token costs less ` + (isFinite(multiple) ? `until usage grows about ${f.num(multiple, multiple < 10 ? 1 : 0)}×.` : 'across the whole range modeled (up to 2,000× today).');
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
      if (sp.status === 'placeholder') { warn('Server pricing', 'placeholder — replace with current list pricing'); uncertain++; }
      else ok('Server pricing', sp.status === 'override' ? 'your entered pricing' : 'current pricing');
    }
    const ps = TC.priceStatus;
    ok('API & GPU rental prices', ps && ps.date ? `public list prices, checked ${ps.date}` : 'public list prices');
    ok('Model architecture', 'from the published model configuration');
    const a = data.assumptions;
    const phAssump = ['power.load_factor_pct', 'onprem.support_pct_per_year', 'onprem.net_storage_pct_of_servers']
      .filter(p => { const [x, y] = p.split('.'); return a[x][y] && a[x][y].status === 'placeholder'; }).length;
    if (phAssump) { warn('Operating assumptions', 'default power load, support and networking percentages'); uncertain++; }
    else ok('Operating assumptions', 'reviewed values');
    const level = uncertain === 0 ? 'High' : uncertain === 1 ? 'Medium' : 'Low';

    return {
      onLabel,
      on, cl, api, closed, onRange, clRange, multiple, verdict, why, checks, level, hybrid: hy,
      breakevenTokens: isFinite(multiple) && multiple > 0 ? multiple * wl.tMo : null,
      altLabel: api ? 'paying per token for the same model' : 'renting GPUs',
    };
  };

  /** "$1.2M–$1.6M" style range, per year. */
  /** "Range $106K–$150K/yr if uncertain inputs land better or worse", or '' when the range is negligible. */
  TC.rangeNote = r => {
    if (!r) return '';
    const a = r.min * 12, b = r.max * 12;
    return Math.abs(b - a) / Math.max(a, 1) < 0.03 ? '' : `Range ${f.usdCompact(a)}–${f.usdCompact(b)}/yr`;
  };
  TC.fmtRangeYear = (r, point) => {
    if (!r) return f.usdCompact(point * 12);
    const a = r.min * 12, b = r.max * 12;
    return Math.abs(b - a) / Math.max(a, 1) < 0.03 ? f.usdCompact(a) : `${f.usdCompact(a)}–${f.usdCompact(b)}`;
  };
})();
