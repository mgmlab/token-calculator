/* GPU cloud: same replica sizing as on-prem, priced per GPU-hour. */
(function () {
  const TC = window.TC;
  const S = TC.step;
  const f = TC.fmt;
  const v = TC.v;

  /**
   * Chooses the reserved rate for the comparison term. Offers may publish rates per commitment
   * length (reserved_terms_per_gpu_hr: {"1": …, "3": …, "5": …}); the longest term that does not
   * exceed the comparison term is used (renewed at the same rate), else the shortest available.
   */
  TC.pickReserved = function (offer, termYears) {
    const terms = offer.reserved_terms_per_gpu_hr;
    if (terms) {
      const ks = Object.keys(terms).map(Number).filter(k => terms[k] && typeof v(terms[k]) === 'number').sort((a, b) => a - b);
      if (ks.length) {
        const fit = ks.filter(k => k <= termYears);
        const k = fit.length ? fit[fit.length - 1] : ks[0];
        const flags = [];
        if (k < termYears) flags.push(`Priced at the ${k}-year commitment rate, renewed at the same rate for a ${termYears}-year term${ks.includes(termYears) ? '' : ` (no ${termYears}-year rate published)`}.`);
        if (k > termYears) flags.push(`Shortest published commitment is ${k} years — longer than your ${termYears}-year term.`);
        return { rate: terms[k], years: k, label: `${k}-yr commitment`, flags };
      }
    }
    if (offer.reserved_per_gpu_hr && typeof v(offer.reserved_per_gpu_hr) === 'number') {
      return { rate: offer.reserved_per_gpu_hr, years: null, label: offer.reserved_term || '', flags: [] };
    }
    return null;
  };

  TC.runCloud = function (data, w, wl) {
    const model = data.models.models.find(m => m.id === w.model_id);
    const rows = [];
    if (!model || !model.self_hostable) return rows;
    const hpm = data.assumptions.cloud.hours_per_month || 730;
    const months = 12 * w.term_years;

    data.gpus.gpus.forEach(gpu => {
      (gpu.cloud || []).forEach(offer => {
        const gpi = offer.gpus_per_instance;
        const sizing = TC.sizeOnGpu({ model, gpu, gpn: gpi, w, a: data.assumptions, benchmarks: data.benchmarks.benchmarks });
        const base = { gpu, offer, sizing, name: offer.provider, sub: `${gpu.name} · ${offer.instance}` };

        const make = (kind, rateObj, hours, hoursLabel, rsv) => {
          const row = Object.assign({}, base, { category: kind === 'reserved' ? 'cloud_reserved' : 'cloud_ondemand', id: `cloud:${kind}:${gpu.id}:${offer.provider}:${offer.instance}` });
          row.pricing = kind === 'reserved' ? `Reserved${rsv.label ? ' (' + rsv.label + ')' : ''}` : (offer.on_demand_label || 'On-demand');
          if (!sizing.feasible) { row.feasible = false; row.reason = sizing.reason; return row; }
          const c = sizing.best;
          const prov = new TC.Provenance();
          const rate = prov.use(`${offer.provider} ${gpu.name} ${kind} $/GPU-hr`, rateObj);
          const gpus = c.nodes * gpi;
          const steps = [
            S('Instances', `${c.replicas} replicas at TP ${c.tp}${c.pp > 1 ? '×PP ' + c.pp : ''} packed into ${gpi}-GPU instances (same sizing as on-prem)`, c.nodes, 'instances'),
            S('GPUs billed', `${c.nodes} instances × ${gpi} GPUs`, gpus, 'GPUs'),
          ];
          const monthly = gpus * rate * hours;
          steps.push(S('Monthly cost', `${gpus} GPUs × $${f.num(rate, 3)}/GPU-hr × ${f.num(hours)} h/month (${hoursLabel})`, monthly, 'USD/mo'));
          const total = monthly * months;
          steps.push(S('Total cost over term', `${f.usd(monthly)} × ${months} months`, total, 'USD'));
          const perM = total / (wl.tTerm / 1e6);
          steps.push(S('$ per million tokens', `${f.usd(total)} ÷ ${f.tokens(wl.tTerm)} tokens × 1M`, perM, 'USD/M'));
          const u = TC.utilization(c, gpi, wl);
          if (kind === 'ondemand') u.util = Math.min(1, u.util * 730 / Math.max(hours, 1));
          u.steps.forEach(s => steps.push(s));
          if (kind === 'ondemand') steps.push(S('Utilization while running', `× 730 ÷ ${f.num(hours)} active hours`, u.util * 100, '%'));
          const flags = [...sizing.flags, ...c.flags];
          if (kind === 'ondemand') flags.push('On-demand capacity for high-end GPUs is not guaranteed; excludes storage, egress and data-transfer charges.');
          if (kind === 'reserved') flags.push(...rsv.flags);
          if (kind === 'reserved' && !rsv.years && offer.reserved_term && months > 12 && /1 yr|Capacity Block/i.test(offer.reserved_term)) {
            flags.push(`Published reserved rate is for "${offer.reserved_term}"; a ${w.term_years}-year commitment is usually quoted lower.`);
          }
          return Object.assign(row, {
            feasible: true, monthly, total, perM, flags, basis: c.basis, util: u.util,
            cost: { steps, prov, nodes: c.nodes, gpus },
            placeholders: [...sizing.prov.placeholders, ...prov.placeholders],
          });
        };

        const rsv = TC.pickReserved(offer, w.term_years);
        if (rsv) rows.push(make('reserved', rsv.rate, hpm, 'billed 24/7', rsv));
        if (offer.on_demand_per_gpu_hr && v(offer.on_demand_per_gpu_hr) != null) {
          rows.push(make('ondemand', offer.on_demand_per_gpu_hr, w.cloud_active_hours_per_month, 'active hours'));
        }
      });
    });
    return rows;
  };
})();
