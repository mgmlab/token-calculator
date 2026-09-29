/* Breakeven chart: monthly cost (dollar axis) vs monthly token volume (log axis), plain SVG. */
(function () {
  const TC = window.TC;
  const f = TC.fmt;
  const esc = TC.esc;
  const hidden = new Set();
  let showTable = false;
  let kMax = 500;
  let showHelp = true;
  try { showHelp = localStorage.getItem('tc.beHelp') !== '0'; } catch (e) { /* ignore */ }
  const valOf = (p, key) => {
    const v = p.series[key];
    return v && v.monthly > 0 ? v.monthly : null;
  };

  const W = 920, H = 440, M = { l: 72, r: 24, t: 20, b: 48 };

  function logTicks(min, max) {
    const out = [];
    for (let e = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e++) {
      const t = Math.pow(10, e);
      if (t >= min * 0.999 && t <= max * 1.001) out.push(t);
    }
    return out;
  }

  function peakNote(w, be) {
    const we = TC.effectiveWorkload(w);
    const wl = TC.workload(we);
    const ratio = we.peak_concurrent_requests / Math.max(wl.avgConc24h, 1e-9);
    const first = be.points[0], last = be.points[be.points.length - 1];
    const u = p => (p.series.onprem && p.series.onprem.util != null ? f.num(p.series.onprem.util * 100, 1) + '%' : '—');
    let s = `Peak concurrency (${f.int(we.peak_concurrent_requests)}) is ${f.num(ratio, 1)}× the 24-hour average implied by your volume. Self-hosted capacity is sized for the peak and paid for around the clock, while API cost follows volume — so utilization decides the breakeven. Lowest-cost on-prem utilization runs from ${u(first)} at the low end of the range to ${u(last)} at the high end.`;
    if (w.peak_concurrency_mode === 'derived') s += ' Peak is derived from your traffic pattern, so bursts shrink relative to volume as usage grows.';
    else s += ' Peak concurrency is entered manually, so it scales linearly with users and utilization never improves — switch to "Derive from traffic pattern" for a more realistic curve.';
    return TC.esc(s);
  }

  TC.renderBreakeven = function (el, data, w) {
    const be = TC.breakeven(data, w, { kMax });
    const pts = be.points;
    const series = TC.SERIES.map((s, i) => Object.assign({}, s, { color: `var(--series-${i + 1})` }));
    const active = series.filter(s => !hidden.has(s.key) && pts.some(p => p.series[s.key]));

    const xs = pts.map(p => p.tokensMonth);
    const ys = [];
    pts.forEach(p => active.forEach(s => { const v = valOf(p, s.key); if (v != null) ys.push(v); }));
    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    // Plain dollar axis, so the growing dollar gap between options is visible
    // (a log dollar axis shrinks a 2× gap to a sliver).
    const top = ys.length ? Math.max(...ys) : 1;
    const raw = top / 5, pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * pow).find(x => x >= raw);
    const yMin = 0, yMax = Math.ceil(top / step) * step;
    const yTicks = [];
    for (let t = 0; t <= yMax + 1e-9; t += step) yTicks.push(t);
    const X = x => M.l + (Math.log10(x) - Math.log10(xMin)) / (Math.log10(xMax) - Math.log10(xMin)) * (W - M.l - M.r);
    const Y = y => H - M.b - (y - yMin) / (yMax - yMin) * (H - M.t - M.b);

    let svg = `<svg viewBox="0 0 ${W} ${H}" class="be-chart" role="img" aria-label="Monthly cost versus monthly token volume for each option category">`;
    yTicks.forEach(t => {
      svg += `<line class="grid" x1="${M.l}" x2="${W - M.r}" y1="${Y(t)}" y2="${Y(t)}"/><text class="tick" x="${M.l - 8}" y="${Y(t) + 4}" text-anchor="end">${f.usdCompact(t)}</text>`;
    });
    logTicks(xMin, xMax).forEach(t => {
      svg += `<line class="grid" x1="${X(t)}" x2="${X(t)}" y1="${M.t}" y2="${H - M.b}"/><text class="tick" x="${X(t)}" y="${H - M.b + 18}" text-anchor="middle">${f.tokens(t)}</text>`;
    });
    svg += `<line class="axis" x1="${M.l}" x2="${W - M.r}" y1="${H - M.b}" y2="${H - M.b}"/>`;
    svg += `<text class="axis-label" x="${(M.l + W - M.r) / 2}" y="${H - 8}" text-anchor="middle">Tokens per month (input + output, log scale)</text>`;
    svg += `<text class="axis-label" transform="translate(16 ${(M.t + H - M.b) / 2}) rotate(-90)" text-anchor="middle">Monthly cost</text>`;

    const cx = X(be.currentTokens);
    if (be.currentTokens >= xMin && be.currentTokens <= xMax) {
      svg += `<line class="current" x1="${cx}" x2="${cx}" y1="${M.t}" y2="${H - M.b}"/><text class="current-label" x="${cx + 5}" y="${M.t + 12}">You are here (${f.tokens(be.currentTokens)} tokens/mo)</text>`;
    }

    active.forEach(s => {
      let d = '', pen = false;
      pts.forEach(p => {
        const v = valOf(p, s.key);
        if (v == null) { pen = false; return; }
        d += (pen ? 'L' : 'M') + X(p.tokensMonth).toFixed(1) + ' ' + Y(v).toFixed(1) + ' ';
        pen = true;
      });
      svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>`;
    });

    // Breakeven markers: numbered dots on the chart; the explanation for each number is in
    // the "Breakeven points" list below, so labels never collide on the chart.
    let mk = 0;
    const markNo = {};
    const markPos = []; // placed breakeven circles, so other labels can avoid them
    be.crossovers.forEach(c => {
      if (!(c.index > 0) || hidden.has(c.key) || hidden.has('onprem')) return;
      const p = pts[c.index];
      const x = X(p.tokensMonth), y = Y(valOf(p, 'onprem'));
      const col = series.find(s2 => s2.key === c.key).color;
      markNo[c.key] = ++mk;
      markPos.push({ x, y });
      svg += `<g class="be-mark"><title>Breakeven vs ${esc(c.vs)}: ${f.tokens(p.tokensMonth)} tokens/month</title>
        <circle cx="${x}" cy="${y}" r="11" fill="var(--surface)" stroke="${col}" stroke-width="2.5"/>
        <text x="${x}" y="${y + 4}" text-anchor="middle" class="be-mark-num">${mk}</text></g>`;
    });

    // Monthly view: show the dollar gap between owning servers and pay-per-token at the top of the range.
    const lastPt = pts[pts.length - 1];
    if (!hidden.has('onprem') && !hidden.has('api_same') && lastPt.series.onprem && lastPt.series.api_same) {
      const a = lastPt.series.onprem.monthly, b = lastPt.series.api_same.monthly;
      const xr = X(lastPt.tokensMonth) - 4;
      const ya = Y(a), yb = Y(b);
      const diff = b - a;
      svg += `<line class="gap" x1="${xr}" x2="${xr}" y1="${Math.min(ya, yb)}" y2="${Math.max(ya, yb)}"/>`;
      const label = `${diff > 0 ? 'Owning saves' : 'Pay per token saves'} ${f.usdCompact(Math.abs(diff))}/month`;
      // Try beside the bracket, then above it, then below it — first spot clear of every breakeven circle and the "You are here" label.
      const lw = label.length * 7.6, top = Math.min(ya, yb), bot = Math.max(ya, yb);
      const clear = y => markPos.every(m => !(m.x > xr - 8 - lw - 14 && m.x < xr + 14 && Math.abs(m.y - (y - 4)) < 22)) && y > M.t + 30;
      const spots = [(ya + yb) / 2 + 4, top - 12, bot + 22, top - 40, bot + 50];
      const ly = spots.find(clear) ?? spots[0];
      svg += `<text class="gap-label" x="${xr - 8}" y="${ly}" text-anchor="end">${label}</text>`;
    }

    svg += `<g class="hover" visibility="hidden"><line class="xhair" y1="${M.t}" y2="${H - M.b}"/>${active.map(s => `<circle r="4.5" fill="${s.color}" stroke="var(--surface)" stroke-width="2" data-k="${s.key}"/>`).join('')}</g>`;
    svg += `<rect class="hit" x="${M.l}" y="${M.t}" width="${W - M.l - M.r}" height="${H - M.t - M.b}" fill="transparent"/>`;
    svg += '</svg>';

    const legend = series.map(s => {
      const has = pts.some(p => p.series[s.key]);
      return `<label class="legend-item ${has ? '' : 'disabled'}"><input type="checkbox" data-series="${s.key}" ${hidden.has(s.key) ? '' : 'checked'} ${has ? '' : 'disabled'}><span class="swatch" style="background:${s.color}"></span>${esc(s.label)}${has ? '' : ' <span class="muted">(no data)</span>'}</label>`;
    }).join('');

    const times = t => {
      const r = t / be.currentTokens;
      return r >= 1.5 ? ` — about ${f.num(r, r < 10 ? 1 : 0)}× your usage today` : r <= 0.67 ? ' — below your usage today' : ' — about your usage today';
    };
    const cross = be.crossovers.map(c => {
      const col = series.find(s2 => s2.key === c.key).color;
      let txt;
      if (!c.hasData) txt = `No data to compare owning servers with ${c.vs}.`;
      else if (c.index === 0) txt = `Owning servers is cheaper than ${c.vs} at every usage level shown.`;
      else if (c.index > 0) txt = `${markNo[c.key] ? `<span class="be-num" style="border-color:${col}">${markNo[c.key]}</span> ` : ''}Owning servers becomes cheaper than ${c.vs} above <strong>${f.tokens(c.tokensMonth)} tokens/month</strong>${times(c.tokensMonth)}.`;
      else txt = `${c.vs.charAt(0).toUpperCase() + c.vs.slice(1)} stays cheaper than owning servers across the whole range shown (up to ${f.tokens(pts[pts.length - 1].tokensMonth)} tokens/month).`;
      return `<li><span class="swatch" style="background:${col}"></span><span>${txt}</span></li>`;
    }).join('');

    // Headline: cheapest option at today's usage, and the key breakeven.
    const today = TC.computeAll(data, w);
    let best = null, bestSeries = null;
    TC.SERIES.filter(sr => sr.key !== 'api_closed').forEach(sr => sr.pick(today).forEach(r => { if (r.feasible && (!best || r.monthly < best.monthly)) { best = r; bestSeries = sr; } }));
    const apiCross = be.crossovers.find(c => c.key === 'api_same');
    let headline = best ? `At your usage today (<strong>${f.tokens(be.currentTokens)} tokens/month</strong>), the cheapest way to run this model is <strong>${esc(bestSeries.label.toLowerCase())}</strong> (${esc(best.name)}) at about <strong>${f.usd(best.monthly)}/month</strong>. ` : '';
    if (apiCross && apiCross.index > 0) headline += `Owning servers becomes cheaper than paying per token for the same model once usage passes <strong>${f.tokens(apiCross.tokensMonth)} tokens/month</strong>${times(apiCross.tokensMonth)}.`;
    else if (apiCross && apiCross.index === 0) headline += 'Owning servers is already cheaper than paying per token for the same model.';
    else if (apiCross && apiCross.hasData) headline += `Paying per token stays cheaper than owning servers up to ${f.tokens(pts[pts.length - 1].tokensMonth)} tokens/month — try a larger range or a flatter (24/7) traffic pattern.`;

    const help = `<details class="be-help" ${showHelp ? 'open' : ''}>
      <summary>How to read this chart</summary>
      <div class="be-help-grid">
        <div><h4>Three ways to run an AI model</h4>
          <ul>
            <li><strong>Buy servers (on-prem)</strong> — purchase GPU servers for your own data center or colo. Big upfront cost, then mostly fixed monthly costs (power, support).</li>
            <li><strong>Rent GPUs (GPU cloud)</strong> — rent the same kind of GPU servers from a cloud (Lambda, CoreWeave, AWS…) and run the model yourself. <em>Reserved</em> = committed rental billed 24/7 at a lower rate; <em>on-demand</em> = pay by the hour only while running.</li>
            <li><strong>Pay per token (API)</strong> — send requests to a provider that runs the model for you (Together, Fireworks, OpenAI…). No hardware; you pay only for what you use. This is also "cloud", but you rent answers, not GPUs.</li>
          </ul></div>
        <div><h4>Reading the lines</h4>
          <ul>
            <li>Left to right = more usage (tokens per month). Higher = more expensive per month.</li>
            <li>Each line is the cheapest choice of that type at each usage level.</li>
            <li><strong>Stepped lines</strong> (buy / rent GPUs): you pay for the hardware whether you use it or not; each step is another server added.</li>
            <li><strong>Smooth curves</strong> (pay per token): the bill grows with every token. (The usage axis is compressed so small and large volumes both fit, which is why a straight price line looks curved.)</li>
            <li><strong>Dashed line</strong> = your usage today. <strong>Numbered circles</strong> = breakeven points, explained under the chart: to the right of each, owning servers is cheaper.</li>
            <li>The bracket at the right shows how much owning servers saves (or costs) per month at the top of the range.</li>
          </ul></div>
      </div>
    </details>`;

    let table = '';
    if (showTable) {
      table = `<div class="table-wrap"><table class="results-table compact"><thead><tr><th>Tokens / month</th>${series.map(s => `<th class="num">${esc(s.label)}</th>`).join('')}</tr></thead><tbody>` +
        pts.filter((_, i) => i % 4 === 0 || i === pts.length - 1).map(p => `<tr><td>${f.tokens(p.tokensMonth)}</td>${series.map(s => {
          const v = p.series[s.key];
          return `<td class="num" title="${v ? esc(v.name + ' · ' + v.sub) : ''}">${v ? f.usd(v.monthly) + '<br><span class="muted small">' + f.perM(v.monthly / p.tokensMonth * 1e6) + ' /1M</span>' : '—'}</td>`;
        }).join('')}</tr>`).join('') + '</tbody></table></div>';
    }

    el.innerHTML = `
      <div class="block-head"><div><h2>Breakeven: when does buying servers pay off?</h2>
        <p class="muted">Monthly cost of each way to run ${esc((data.models.models.find(m => m.id === w.model_id) || {}).name || 'the model')} as usage grows.</p></div>
        <div class="be-controls">
        <label class="small">Show usage up to <select data-act="range">${[20, 100, 500, 2000].map(k => `<option value="${k}" ${k === kMax ? 'selected' : ''}>${k}× today</option>`).join('')}</select></label></div></div>
      ${help}
      ${headline ? `<p class="be-headline">${headline}</p>` : ''}
      <div class="legend">${legend}</div>
      <div class="chart-wrap">${svg}<div class="tooltip" hidden></div></div>
      <h3>Breakeven points</h3>
      <ul class="crossovers">${cross}</ul>
      <details class="be-more">
        <summary>Why the lines look like this (technical detail)</summary>
        <p>${peakNote(w, be)}</p>
        <p class="muted small">Usage is scaled from 0.02× to ${kMax}× today by changing the number of users (peak concurrency ${w.peak_concurrency_mode === 'derived' ? 'recomputed from the traffic pattern at each level' : 'scaled linearly'}). Owned servers are spread evenly over ${w.term_years} years. Server prices are placeholders until replaced with quotes, and they strongly affect where lines cross — check the ⚠ values on the Compare tab.</p>
        <button class="btn ghost small" data-act="table">${showTable ? 'Hide' : 'Show'} data table</button>
        ${table}
      </details>`;

    const det = el.querySelector('.be-help');
    det.addEventListener('toggle', () => { showHelp = det.open; try { localStorage.setItem('tc.beHelp', det.open ? '1' : '0'); } catch (e) { /* ignore */ } });
    if (showTable) el.querySelector('.be-more').open = true;

    el.querySelectorAll('[data-series]').forEach(cb => cb.onchange = () => {
      if (cb.checked) hidden.delete(cb.dataset.series); else hidden.add(cb.dataset.series);
      TC.renderBreakeven(el, data, w);
    });
    el.querySelector('[data-act="range"]').onchange = e => { kMax = Number(e.target.value); TC.renderBreakeven(el, data, w); };
    el.querySelector('[data-act="table"]').onclick = () => { showTable = !showTable; TC.renderBreakeven(el, data, w); };

    // Crosshair + tooltip
    const svgEl = el.querySelector('svg');
    const hit = svgEl.querySelector('.hit');
    const hov = svgEl.querySelector('.hover');
    const tip = el.querySelector('.tooltip');
    const wrap = el.querySelector('.chart-wrap');
    const move = evt => {
      const r = svgEl.getBoundingClientRect();
      const sx = (evt.clientX - r.left) * (W / r.width);
      let best = 0, bd = Infinity;
      pts.forEach((p, i) => { const d = Math.abs(X(p.tokensMonth) - sx); if (d < bd) { bd = d; best = i; } });
      const p = pts[best];
      const px = X(p.tokensMonth);
      hov.setAttribute('visibility', 'visible');
      hov.querySelector('.xhair').setAttribute('x1', px);
      hov.querySelector('.xhair').setAttribute('x2', px);
      hov.querySelectorAll('circle').forEach(c => {
        const v = valOf(p, c.dataset.k);
        if (v != null) { c.setAttribute('cx', px); c.setAttribute('cy', Y(v)); c.setAttribute('visibility', 'visible'); }
        else c.setAttribute('visibility', 'hidden');
      });
      tip.hidden = false;
      tip.innerHTML = `<div class="tip-head">${f.tokens(p.tokensMonth)} tokens / month</div>` + active.map(s => {
        const v = p.series[s.key];
        return `<div class="tip-row"><span class="swatch" style="background:${s.color}"></span><span class="tip-label">${esc(s.label)}</span><span class="tip-val">${v ? f.usd(v.monthly) + '/mo' : '—'}</span></div>${v ? `<div class="tip-sub">${esc(v.name)} · ${esc(v.sub)}</div>` : ''}`;
      }).join('');
      const wr = wrap.getBoundingClientRect();
      const left = evt.clientX - wr.left;
      tip.style.left = (left > wr.width / 2 ? left - tip.offsetWidth - 14 : left + 14) + 'px';
      tip.style.top = Math.max(0, evt.clientY - wr.top - 20) + 'px';
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerleave', () => { hov.setAttribute('visibility', 'hidden'); tip.hidden = true; });
  };
})();
