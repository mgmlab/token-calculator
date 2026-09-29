/* Turns the shared workload profile into token volumes. */
(function () {
  const TC = window.TC;
  const S = TC.step;

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

    const flags = [];
    if (avgConc24h > w.peak_concurrent_requests) {
      flags.push(`Peak concurrency (${w.peak_concurrent_requests}) is below the 24-hour average implied by volume (${TC.fmt.num(avgConc24h, 1)} = req/sec × output tokens ÷ target tok/s). Peak should be at least that high.`);
    }
    const ratio = w.avg_input_tokens / Math.max(w.avg_output_tokens, 1);

    return { reqDay, reqMonth, tInMo, tOutMo, tMo, months, tTerm, avgConc24h, inOutRatio: ratio, steps, flags };
  };
})();
