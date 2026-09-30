/* Options removed from the current analysis (not deleted from the data).
 * Kinds: models / gpus / servers (dataset record ids) and rows (one Compare row, e.g. a cloud offer or API provider).
 * Saved in this browser with the scenario; "New analysis" brings them back.
 */
(function () {
  const TC = window.TC;
  const KEY = 'tc.excluded';
  const KINDS = ['models', 'gpus', 'servers', 'rows'];
  const listeners = [];

  function read() {
    const o = TC.storage.get(KEY) || {};
    const x = { labels: o.labels || {} };
    KINDS.forEach(k => { x[k] = Array.isArray(o[k]) ? o[k] : []; });
    return x;
  }
  function write(x) {
    if (TC.excl.count(x)) TC.storage.set(KEY, x); else TC.storage.remove(KEY);
    listeners.forEach(fn => fn());
  }

  TC.excl = {
    KINDS,
    get: read,
    has(kind, id) { return read()[kind].includes(id); },
    count(x) { x = x || read(); return KINDS.reduce((n, k) => n + x[k].length, 0); },
    /** Exclude (on=true) or restore (on=false) ids of one kind; labels are kept for the Compare list. */
    set(kind, ids, on, labels) {
      const x = read();
      const s = new Set(x[kind]);
      ids.forEach((id, i) => {
        const key = kind + ':' + id;
        if (on) { s.add(id); if (labels && labels[i]) x.labels[key] = labels[i]; } else { s.delete(id); delete x.labels[key]; }
      });
      x[kind] = [...s];
      write(x);
    },
    /** Replace everything with a saved set (from a share link or scenario file); null clears. */
    replace(o) {
      const x = { labels: (o && o.labels) || {} };
      KINDS.forEach(k => { x[k] = o && Array.isArray(o[k]) ? o[k].map(String) : []; });
      write(x);
    },
    clear() { TC.storage.remove(KEY); listeners.forEach(fn => fn()); },
    onChange(fn) { listeners.push(fn); },
    /** Everything excluded, as [{kind, id, label}] for display. */
    list() {
      const x = read();
      return KINDS.flatMap(k => x[k].map(id => ({ kind: k, id, label: x.labels[k + ':' + id] || id })));
    },
    /** Datasets with excluded models, GPUs and servers removed (servers on an excluded GPU go too). */
    filterData(d) {
      const x = read();
      if (!TC.excl.count(x)) return d;
      const out = Object.assign({}, d);
      const gx = new Set(x.gpus), mx = new Set(x.models), sx = new Set(x.servers);
      if (d.models) out.models = Object.assign({}, d.models, { models: d.models.models.filter(m => !mx.has(m.id)) });
      if (d.gpus) out.gpus = Object.assign({}, d.gpus, { gpus: d.gpus.gpus.filter(g => !gx.has(g.id)) });
      if (d.servers) out.servers = Object.assign({}, d.servers, { servers: d.servers.servers.filter(s => !sx.has(s.id) && !gx.has(s.gpu_id)) });
      return out;
    },
    /** Result rows minus individually excluded ones. */
    filterRows(rows) {
      const rx = new Set(read().rows);
      return rx.size ? rows.filter(r => !rx.has(r.id)) : rows;
    },
  };
})();
