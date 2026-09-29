/* Renders "show the math" panels: steps, alternative layouts, provenance. */
(function () {
  const TC = window.TC;
  const f = TC.fmt;
  const esc = TC.esc;

  function fmtVal(value, unit) {
    if (value == null || (typeof value === 'number' && !isFinite(value))) return '—';
    if (typeof value !== 'number') return esc(value);
    if (unit === 'USD' || unit === 'USD/mo') return f.usd(value);
    if (unit === 'USD/M') return f.perM(value);
    if (unit === 'tokens') return f.tokens(value) + ' <span class="muted">(' + f.int(value) + ')</span>';
    if (unit === 'GB' || unit === 'TB/s' || unit === 'TFLOPS' || unit === 'ms' || unit === '×') return f.num(value, value < 1 ? 4 : 2) + ' ' + unit;
    return f.num(value, 2) + (unit ? ' ' + esc(unit) : '');
  }

  TC.renderSteps = function (title, steps) {
    if (!steps || !steps.length) return '';
    return `<h4>${esc(title)}</h4><table class="math"><tbody>` + steps.map(s => `
      <tr class="${/^THEORETICAL/.test(s.label) ? 'theory' : ''}">
        <th>${esc(s.label)}</th>
        <td class="formula">${esc(s.formula)}${s.note ? `<div class="note">${esc(s.note)}</div>` : ''}</td>
        <td class="val">${fmtVal(s.value, s.unit)}</td>
      </tr>`).join('') + '</tbody></table>';
  };

  TC.renderProvenance = function (items) {
    if (!items || !items.length) return '';
    const seen = new Set();
    const uniq = items.filter(i => { const k = i.label; if (seen.has(k)) return false; seen.add(k); return true; });
    return `<h4>Data values used</h4><table class="prov"><thead><tr><th>Value</th><th></th><th>Status</th><th>Source</th><th>As of</th></tr></thead><tbody>` +
      uniq.map(i => `<tr>
        <td>${esc(i.label)}</td>
        <td class="val">${typeof i.value === 'number' ? f.num(i.value, 4) : esc(i.value)}</td>
        <td><span class="badge st-${esc(i.status)}">${esc(i.status || '—')}</span></td>
        <td class="src">${esc(i.source)}</td>
        <td class="nowrap">${esc(i.as_of)}</td>
      </tr>`).join('') + '</tbody></table>';
  };

  TC.renderCandidates = function (sizing) {
    if (!sizing || !sizing.candidates || sizing.candidates.length < 2) return '';
    return `<h4>Layouts evaluated</h4><table class="cands"><thead><tr><th>Layout</th><th>GPUs/replica</th><th>Max conc./replica</th><th>Basis</th><th>Agg. tok/s</th><th>Replicas</th><th>Nodes</th><th></th></tr></thead><tbody>` +
      sizing.candidates.map(c => `<tr class="${c === sizing.best ? 'chosen' : ''}">
        <td>TP ${c.tp}${c.pp > 1 ? ' × PP ' + c.pp : ''}</td>
        <td>${c.gpusPerReplica}</td>
        <td>${c.feasible ? f.int(c.Crep) : '—'}</td>
        <td>${c.feasible ? basisLabel(c.basis, c.lab) : '—'}</td>
        <td>${c.feasible ? f.int(c.aggTps) : '—'}</td>
        <td>${c.feasible ? c.replicas : '—'}</td>
        <td>${c.feasible ? c.nodes : '—'}</td>
        <td class="muted">${c === sizing.best ? 'chosen' : esc(c.reason || '')}</td>
      </tr>`).join('') + '</tbody></table>';
  };

  function basisLabel(b, lab) {
    if (b === 'benchmark' && lab) return '<span class="badge basis-lab">Pellera lab benchmark</span>';
    if (b === 'benchmark') return '<span class="badge basis-bench">measured benchmark</span>';
    if (b === 'theoretical') return '<span class="badge basis-theory">theoretical estimate</span>';
    return esc(b || '');
  }
  TC.basisLabel = basisLabel;

  /** Full math panel for one result row. */
  TC.renderMath = function (row, wl) {
    let h = '<div class="math-panel">';
    if (row.flags && row.flags.length) {
      h += '<ul class="flags">' + row.flags.map(x => `<li>${esc(x)}</li>`).join('') + '</ul>';
    }
    h += TC.renderSteps('Workload', wl.steps);
    if (row.sizing && row.sizing.best) {
      if (row.sizing.best.basis === 'theoretical') {
        h += '<p class="callout warn">Throughput below is the <strong>theoretical bandwidth-based estimate</strong>, not a measured benchmark. Add a benchmark row in the Data editor to replace it.</p>';
      }
      h += TC.renderSteps('Sizing — model memory', row.sizing.shared.steps);
      h += TC.renderSteps(`Sizing — chosen layout (TP ${row.sizing.best.tp}${row.sizing.best.pp > 1 ? ' × PP ' + row.sizing.best.pp : ''})`, row.sizing.best.steps);
      h += TC.renderCandidates(row.sizing);
    }
    if (row.cost) h += TC.renderSteps('Cost', row.cost.steps);
    const prov = [].concat(row.sizing ? row.sizing.prov.items : [], row.cost ? row.cost.prov.items : []);
    h += TC.renderProvenance(prov);
    h += '</div>';
    return h;
  };
})();
