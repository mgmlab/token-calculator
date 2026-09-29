/* Breakeven chart: monthly cost vs monthly token volume (log-log), plain SVG. */
(function () {
  const TC = window.TC;
  const f = TC.fmt;
  const esc = TC.esc;
  const hidden = new Set();
  let showTable = false;
  let kMax = 100;

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
    pts.forEach(p => active.forEach(s => { const v = p.series[s.key]; if (v && v.monthly > 0) ys.push(v.monthly); }));
    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    const yMin = ys.length ? Math.pow(10, Math.floor(Math.log10(Math.min(...ys)))) : 1;
    const yMax = ys.length ? Math.pow(10, Math.ceil(Math.log10(Math.max(...ys)))) : 10;
    const X = x => M.l + (Math.log10(x) - Math.log10(xMin)) / (Math.log10(xMax) - Math.log10(xMin)) * (W - M.l - M.r);
    const Y = y => H - M.b - (Math.log10(y) - Math.log10(yMin)) / (Math.log10(yMax) - Math.log10(yMin)) * (H - M.t - M.b);

    let svg = `<svg viewBox="0 0 ${W} ${H}" class="be-chart" role="img" aria-label="Monthly cost versus monthly token volume for each option category">`;
    logTicks(yMin, yMax).forEach(t => {
      svg += `<line class="grid" x1="${M.l}" x2="${W - M.r}" y1="${Y(t)}" y2="${Y(t)}"/><text class="tick" x="${M.l - 8}" y="${Y(t) + 4}" text-anchor="end">${f.usdCompact(t)}</text>`;
    });
    logTicks(xMin, xMax).forEach(t => {
      svg += `<line class="grid" x1="${X(t)}" x2="${X(t)}" y1="${M.t}" y2="${H - M.b}"/><text class="tick" x="${X(t)}" y="${H - M.b + 18}" text-anchor="middle">${f.tokens(t)}</text>`;
    });
    svg += `<line class="axis" x1="${M.l}" x2="${W - M.r}" y1="${H - M.b}" y2="${H - M.b}"/>`;
    svg += `<text class="axis-label" x="${(M.l + W - M.r) / 2}" y="${H - 8}" text-anchor="middle">Tokens per month (input + output, log scale)</text>`;
    svg += `<text class="axis-label" transform="translate(16 ${(M.t + H - M.b) / 2}) rotate(-90)" text-anchor="middle">Monthly cost (log scale)</text>`;

    const cx = X(be.currentTokens);
    if (be.currentTokens >= xMin && be.currentTokens <= xMax) {
      svg += `<line class="current" x1="${cx}" x2="${cx}" y1="${M.t}" y2="${H - M.b}"/><text class="current-label" x="${cx + 4}" y="${M.t + 12}">your profile</text>`;
    }

    active.forEach(s => {
      let d = '', pen = false;
      pts.forEach(p => {
        const v = p.series[s.key];
        if (!v || !(v.monthly > 0)) { pen = false; return; }
        d += (pen ? 'L' : 'M') + X(p.tokensMonth).toFixed(1) + ' ' + Y(v.monthly).toFixed(1) + ' ';
        pen = true;
      });
      svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>`;
    });

    svg += `<g class="hover" visibility="hidden"><line class="xhair" y1="${M.t}" y2="${H - M.b}"/>${active.map(s => `<circle r="4.5" fill="${s.color}" stroke="var(--surface)" stroke-width="2" data-k="${s.key}"/>`).join('')}</g>`;
    svg += `<rect class="hit" x="${M.l}" y="${M.t}" width="${W - M.l - M.r}" height="${H - M.t - M.b}" fill="transparent"/>`;
    svg += '</svg>';

    const legend = series.map(s => {
      const has = pts.some(p => p.series[s.key]);
      return `<label class="legend-item ${has ? '' : 'disabled'}"><input type="checkbox" data-series="${s.key}" ${hidden.has(s.key) ? '' : 'checked'} ${has ? '' : 'disabled'}><span class="swatch" style="background:${s.color}"></span>${esc(s.label)}${has ? '' : ' <span class="muted">(no data)</span>'}</label>`;
    }).join('');

    const cross = be.crossovers.map(c => `<li><span class="swatch" style="background:${series.find(s => s.key === c.key).color}"></span>On-prem vs <strong>${esc(c.label.replace(' (cheapest)', ''))}</strong>: ${esc(c.text)}</li>`).join('');

    let table = '';
    if (showTable) {
      table = `<div class="table-wrap"><table class="results-table compact"><thead><tr><th>Tokens / month</th>${series.map(s => `<th class="num">${esc(s.label)}</th>`).join('')}</tr></thead><tbody>` +
        pts.filter((_, i) => i % 4 === 0 || i === pts.length - 1).map(p => `<tr><td>${f.tokens(p.tokensMonth)}</td>${series.map(s => {
          const v = p.series[s.key];
          return `<td class="num" title="${v ? esc(v.name + ' · ' + v.sub) : ''}">${v ? f.usd(v.monthly) : '—'}</td>`;
        }).join('')}</tr>`).join('') + '</tbody></table></div>';
    }

    el.innerHTML = `
      <div class="block-head"><div><h2>Breakeven</h2>
        <p class="muted">Users scaled from 0.02× to ${kMax}× your profile (peak concurrency ${w.peak_concurrency_mode === 'derived' ? 'recomputed from the traffic pattern at each volume' : 'scaled linearly'}). Each line is the cheapest option in that category at each volume. On-prem is amortized straight-line over ${w.term_years} years.</p></div>
        <label class="small">Range up to <select data-act="range">${[20, 100, 500, 2000].map(k => `<option value="${k}" ${k === kMax ? 'selected' : ''}>${k}× profile</option>`).join('')}</select></label></div>
      <div class="legend">${legend}</div>
      <div class="chart-wrap">${svg}<div class="tooltip" hidden></div></div>
      <h3>Crossover points</h3>
      <ul class="crossovers">${cross}</ul>
      <p class="callout">${peakNote(w, be)}</p>
      <p class="muted small">Your profile: ${f.tokens(be.currentTokens)} tokens/month. On-prem and reserved-cloud lines step up as nodes are added; placeholder server prices strongly affect where the lines cross — check the ⚠ values on the Compare tab.</p>
      <button class="btn ghost small" data-act="table">${showTable ? 'Hide' : 'Show'} data table</button>
      ${table}`;

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
        const v = p.series[c.dataset.k];
        if (v && v.monthly > 0) { c.setAttribute('cx', px); c.setAttribute('cy', Y(v.monthly)); c.setAttribute('visibility', 'visible'); }
        else c.setAttribute('visibility', 'hidden');
      });
      tip.hidden = false;
      tip.innerHTML = `<div class="tip-head">${f.tokens(p.tokensMonth)} tokens / month</div>` + active.map(s => {
        const v = p.series[s.key];
        return `<div class="tip-row"><span class="swatch" style="background:${s.color}"></span><span class="tip-label">${esc(s.label.replace(' (cheapest)', ''))}</span><span class="tip-val">${v ? f.usd(v.monthly) : '—'}</span></div>${v ? `<div class="tip-sub">${esc(v.name)} · ${esc(v.sub)}</div>` : ''}`;
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
