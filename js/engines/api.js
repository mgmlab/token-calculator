/* Public API per-token pricing. */
(function () {
  const TC = window.TC;
  const S = TC.step;
  const f = TC.fmt;
  const v = TC.v;

  TC.apiRow = function (model, price, w, wl) {
    const prov = new TC.Provenance();
    const months = 12 * w.term_years;
    const pin = prov.use(`${price.provider} ${model.name} input $/M`, price.input_per_m);
    const pout = prov.use(`${price.provider} ${model.name} output $/M`, price.output_per_m);
    const flags = [];
    const steps = [];

    const hit = w.api_cache_hit_pct / 100;
    let effIn = pin;
    if (hit > 0) {
      if (price.cached_input_per_m && v(price.cached_input_per_m) != null) {
        const pc = prov.use(`${price.provider} ${model.name} cached input $/M`, price.cached_input_per_m);
        effIn = (1 - hit) * pin + hit * pc;
        steps.push(S('Effective input price', `(1 − ${f.num(hit * 100)}%) × $${f.num(pin, 4)} + ${f.num(hit * 100)}% × $${f.num(pc, 4)} cached`, effIn, 'USD/M',
          'Cache-write premiums (where a provider charges them) are not modeled.'));
      } else {
        flags.push('No cached-input price on file for this provider; cache hit % ignored.');
      }
    }
    const inCost = wl.tInMo / 1e6 * effIn;
    const outCost = wl.tOutMo / 1e6 * pout;
    steps.push(S('Input cost per month', `${f.tokens(wl.tInMo)} tokens ÷ 1M × $${f.num(effIn, 4)}`, inCost, 'USD/mo'));
    steps.push(S('Output cost per month', `${f.tokens(wl.tOutMo)} tokens ÷ 1M × $${f.num(pout, 4)}`, outCost, 'USD/mo'));

    let monthly = inCost + outCost;
    const share = w.api_batch_share_pct / 100;
    if (share > 0) {
      if (price.batch_discount_pct && v(price.batch_discount_pct) != null) {
        const d = prov.use(`${price.provider} batch discount %`, price.batch_discount_pct) / 100;
        const factor = 1 - share * d;
        steps.push(S('Batch discount', `× (1 − ${f.num(share * 100)}% batch share × ${f.num(d * 100)}% discount)`, factor, '×'));
        monthly *= factor;
      } else {
        flags.push('No batch discount on file for this provider; batch share ignored.');
      }
    }
    steps.push(S('Monthly cost', 'input + output (after discounts)', monthly, 'USD/mo'));
    const total = monthly * months;
    steps.push(S('Total cost over term', `${f.usd(monthly)} × ${months} months (prices held flat)`, total, 'USD'));
    const perM = total / (wl.tTerm / 1e6);
    steps.push(S('Blended $ per million tokens', `${f.usd(total)} ÷ ${f.tokens(wl.tTerm)} tokens × 1M`, perM, 'USD/M'));
    if (price.note) flags.push(price.note);
    if (!model.self_hostable) flags.push('Closed model — reference only, not the same model as the on-prem sizing.');

    return {
      category: 'api', id: `api:${model.id}:${price.provider}`, feasible: true,
      name: price.provider, sub: model.name, model, price, sameModel: model.self_hostable,
      monthly, total, perM, flags, basis: 'price list',
      cost: { steps, prov }, placeholders: prov.placeholders,
    };
  };

  TC.runApi = function (data, w, wl) {
    const rows = [];
    const priced = p => typeof v(p.input_per_m) === 'number' && typeof v(p.output_per_m) === 'number';
    const sel = data.models.models.find(m => m.id === w.model_id);
    if (sel) (sel.api_prices || []).filter(priced).forEach(p => rows.push(TC.apiRow(sel, p, w, wl)));
    if (w.include_closed_models) {
      data.models.models.filter(m => !m.self_hostable).forEach(m => (m.api_prices || []).filter(priced).forEach(p => rows.push(TC.apiRow(m, p, w, wl))));
    }
    return rows;
  };
})();
