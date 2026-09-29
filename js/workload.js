/* Turns the shared workload profile into token volumes. */
(function () {
  const TC = window.TC;
  const S = TC.step;

  const Z = { 95: 1.645, 99: 2.326, 99.9: 3.09 };

  /**
   * Returns a copy of the workload with peak_concurrent_requests resolved.
   * Derived mode: busy-hour average concurrency (Little's law) plus a Poisson burst allowance,
   *   mean = busy-hour req/s × seconds per request;  peak = ceil(mean + z × sqrt(mean)).
   * Because the burst term grows with sqrt(volume), peak-to-average falls as usage grows —
   * the statistical smoothing a large deployment really sees.
   */
  TC.effectiveWorkload = function (w) {
    if (w.peak_concurrency_mode !== 'derived') return Object.assign({}, w, { _peak: null });
    const reqDay = w.users * w.requests_per_user_per_day;
    const busyRps = reqDay * (w.busy_hour_share_pct / 100) / 3600;
    const secPerReq = w.avg_output_tokens / Math.max(w.target_output_tps_per_request, 1e-9) + 1;
    const mean = busyRps * secPerReq;
    const z = Z[w.burst_percentile] || Z[99];
    const peak = Math.max(1, Math.ceil(mean + z * Math.sqrt(mean)));
    return Object.assign({}, w, { peak_concurrent_requests: peak, _peak: { busyRps, secPerReq, mean, z, peak } });
  };

  /**
   * @param {object} w workload inputs (see assumptions.json workload_defaults)
   * @returns token volumes + steps
   */
  TC.workload = function (w) {
    const reqDay = w.users * w.requests_per_user_per_day;
    const reqMonth = reqDay * w.active_days_per_month;
    const tInMo = reqMonth * w.avg_input_tokens;
    const tOutMo = reqMonth * w.avg_output_tokens;
    const tMo = tInMo + tOutMo;
    const months = 12 * w.term_years;
    const tTerm = tMo * months;

    // Little's law sanity check: average concurrency if requests were spread evenly over 24h.
    const secPerReq = w.avg_output_tokens / Math.max(w.target_output_tps_per_request, 1e-9);
    const avgConc24h = (reqDay / 86400) * secPerReq;

    const steps = [
      S('Requests per day', `${TC.fmt.int(w.users)} users × ${TC.fmt.num(w.requests_per_user_per_day)} req/user/day`, reqDay, 'req/day'),
      S('Requests per month', `${TC.fmt.int(reqDay)} × ${TC.fmt.num(w.active_days_per_month)} active days/month`, reqMonth, 'req/month'),
      S('Input tokens per month', `${TC.fmt.int(reqMonth)} × ${TC.fmt.int(w.avg_input_tokens)} avg input`, tInMo, 'tokens'),
      S('Output tokens per month', `${TC.fmt.int(reqMonth)} × ${TC.fmt.int(w.avg_output_tokens)} avg output`, tOutMo, 'tokens'),
      S('Total tokens per month', 'input + output', tMo, 'tokens'),
      S('Total tokens over term', `${TC.fmt.tokens(tMo)} × ${months} months`, tTerm, 'tokens'),
    ];
    if (w._peak) {
      const p = w._peak;
      steps.push(
        S('Busy-hour requests per second', `${TC.fmt.int(reqDay)} req/day × ${TC.fmt.num(w.busy_hour_share_pct)}% in busiest hour ÷ 3,600 s`, p.busyRps, 'req/s'),
        S('Seconds per request', `${TC.fmt.int(w.avg_output_tokens)} output tokens ÷ ${TC.fmt.num(w.target_output_tps_per_request)} tok/s + 1 s (prompt processing / queueing)`, p.secPerReq, 's'),
        S('Busy-hour average concurrency', `${TC.fmt.num(p.busyRps, 3)} req/s × ${TC.fmt.num(p.secPerReq)} s (Little's law)`, p.mean, 'requests'),
        S('Peak concurrent requests (derived)', `ceil(${TC.fmt.num(p.mean)} + ${p.z} × √${TC.fmt.num(p.mean)}) — ${w.burst_percentile}th-percentile burst`, p.peak, 'requests',
          'Burst allowance grows with the square root of volume, so larger deployments need proportionally less spare capacity.'),
      );
    }

    const flags = [];
    if (avgConc24h > w.peak_concurrent_requests) {
      flags.push(`Peak concurrency (${w.peak_concurrent_requests}) is below the 24-hour average implied by volume (${TC.fmt.num(avgConc24h, 1)} = req/sec × output tokens ÷ target tok/s). Peak should be at least that high.`);
    }
    const ratio = w.avg_input_tokens / Math.max(w.avg_output_tokens, 1);

    return { reqDay, reqMonth, tInMo, tOutMo, tMo, months, tTerm, avgConc24h, inOutRatio: ratio, steps, flags };
  };
})();
