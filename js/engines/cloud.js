/* GPU cloud: same replica sizing as on-prem, priced per GPU-hour. */
(function () {
  const TC = window.TC;
  const S = TC.step;
  const f = TC.fmt;
  const v = TC.v;

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

        const make = (kind, rateObj, hours, hoursLabel) => {
          const row = Object.assign({}, base, { category: kind === 'reserved' ? 'cloud_reserved' : 'cloud_ondemand', id: `cloud:${kind}:${gpu.id}:${offer.provider}:${offer.instance}` });
          row.pricing = kind === 'reserved' ? `Reserved${offer.reserved_term ? ' (' + offer.reserved_term + ')' : ''}` : 'On-demand';
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
          const flags = [...sizing.flags, ...c.flags];
          if (kind === 'ondemand') flags.push('On-demand capacity for high-end GPUs is not guaranteed; excludes storage, egress and data-transfer charges.');
          if (kind === 'reserved' && offer.reserved_term && months > 12 && /1 yr|Capacity Block/i.test(offer.reserved_term)) {
            flags.push(`Published reserved rate is for "${offer.reserved_term}"; a ${w.term_years}-year commitment is usually quoted lower.`);
          }
          return Object.assign(row, {
            feasible: true, monthly, total, perM, flags, basis: c.basis,
            cost: { steps, prov, nodes: c.nodes, gpus },
            placeholders: [...sizing.prov.placeholders, ...prov.placeholders],
          });
        };

        if (offer.reserved_per_gpu_hr && v(offer.reserved_per_gpu_hr) != null) {
          rows.push(make('reserved', offer.reserved_per_gpu_hr, hpm, 'billed 24/7'));
        }
        if (offer.on_demand_per_gpu_hr && v(offer.on_demand_per_gpu_hr) != null) {
          rows.push(make('ondemand', offer.on_demand_per_gpu_hr, w.cloud_active_hours_per_month, 'active hours'));
        }
      });
    });
    return rows;
  };
})();
