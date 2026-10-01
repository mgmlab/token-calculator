/*
 * Loads /data/*.json, layers browser-saved overrides on top, and handles import/export.
 *   defaults  = what the JSON files on disk contain
 *   overrides = full replacement datasets saved in this browser (localStorage)
 *   cache     = last successful load, so the app still works when opened from file://
 */
(function () {
  const TC = window.TC;
  const NAMES = ['models', 'gpus', 'servers', 'benchmarks', 'assumptions'];
  const KEY_OVR = n => 'tc.override.' + n;
  const KEY_CACHE = n => 'tc.cache.' + n;
  const LIST = { models: 'models', gpus: 'gpus', servers: 'servers', benchmarks: 'benchmarks' };
  // Records are matched by id; benchmark rows have none, so they are matched by what they measured.
  const recKey = (n, r) => r.id || [r.gpu_id, r.model_id, r.precision, r.tp, r.pp, r.engine].join('|');

  const store = (TC.store = {
    NAMES,
    defaults: {},
    source: {},        // name -> 'file' | 'cache' | 'missing'
    listeners: [],

    get(name) {
      const o = TC.storage.get(KEY_OVR(name));
      return o || this.defaults[name] || null;
    },
    isOverridden(name) { return TC.storage.get(KEY_OVR(name)) != null; },
    all() {
      const d = {};
      NAMES.forEach(n => (d[n] = this.get(n)));
      return d;
    },
    /** Datasets as the analysis sees them: excluded models/GPUs/servers removed. */
    analysis() { return TC.excl ? TC.excl.filterData(this.all()) : this.all(); },
    ready() { return NAMES.every(n => this.get(n)); },
    missing() { return NAMES.filter(n => !this.get(n)); },

    async load() {
      await Promise.all(NAMES.map(async n => {
        try {
          const res = await fetch('data/' + n + '.json', { cache: 'no-cache' });
          if (!res.ok) throw new Error(res.status);
          const json = await res.json();
          this.defaults[n] = json;
          this.source[n] = 'file';
          TC.storage.set(KEY_CACHE(n), json);
        } catch (e) {
          const c = TC.storage.get(KEY_CACHE(n));
          if (c) { this.defaults[n] = c; this.source[n] = 'cache'; } else { this.source[n] = 'missing'; }
        }
      }));
    },

    setOverride(name, obj) {
      TC.storage.set(KEY_OVR(name), obj);
      this.emit();
    },
    reset(name) {
      TC.storage.remove(KEY_OVR(name));
      this.emit();
    },
    /**
     * This browser's data edits as a compact patch against the shared files (for share links):
     * list datasets → { u: [changed or added records], r: [keys of removed records] }; assumptions → { s: { section: value } }.
     * Returns null when nothing is edited.
     */
    dataPatch() {
      const out = {};
      NAMES.forEach(n => {
        const o = TC.storage.get(KEY_OVR(n)), base = this.defaults[n];
        if (!o || !base) return;
        const lk = LIST[n];
        if (lk) {
          const bm = new Map((base[lk] || []).map(r => [recKey(n, r), JSON.stringify(r)]));
          const om = new Set();
          const u = (o[lk] || []).filter(r => { const k = recKey(n, r); om.add(k); return bm.get(k) !== JSON.stringify(r); });
          const rm = [...bm.keys()].filter(k => !om.has(k));
          if (u.length || rm.length) out[n] = Object.assign({}, u.length ? { u } : {}, rm.length ? { r: rm } : {});
        } else {
          // Only the changed values, by dotted path (a sourced value {value, source, …} counts as one value).
          const s = {};
          (function walk(a, b, path) {
            Object.keys(a).forEach(k => {
              if (k === '_readme') return;
              const p = path ? path + '.' + k : k, x = a[k], y = b ? b[k] : undefined;
              if (JSON.stringify(x) === JSON.stringify(y)) return;
              const leaf = !x || typeof x !== 'object' || Array.isArray(x) || TC.isWrapped(x) || !y || typeof y !== 'object';
              if (leaf) s[p] = x; else walk(x, y, p);
            });
          })(o, base, '');
          if (Object.keys(s).length) out[n] = { s };
        }
      });
      return Object.keys(out).length ? out : null;
    },
    /** Make this browser's data edits exactly the given patch (null = no edits), applied on top of the shared files. */
    applyDataPatch(patch) {
      NAMES.forEach(n => {
        const p = patch && patch[n], base = this.defaults[n];
        if (!p || !base) { TC.storage.remove(KEY_OVR(n)); return; }
        const obj = TC.clone(base), lk = LIST[n];
        if (lk) {
          const rm = new Set(p.r || []), up = new Map((p.u || []).map(r => [recKey(n, r), r]));
          const list = (obj[lk] || []).filter(r => !rm.has(recKey(n, r))).map(r => { const k = recKey(n, r); const x = up.get(k); if (x) up.delete(k); return x || r; });
          obj[lk] = list.concat([...up.values()]);
        } else {
          Object.entries(p.s || {}).forEach(([path, val]) => {
            const ks = path.split('.'); let t = obj;
            ks.slice(0, -1).forEach(k => { if (!t[k] || typeof t[k] !== 'object') t[k] = {}; t = t[k]; });
            t[ks[ks.length - 1]] = val;
          });
        }
        TC.storage.set(KEY_OVR(n), obj);
      });
      this.emit();
    },
    /** Number of datasets a patch touches. */
    patchSize(patch) { return patch ? Object.keys(patch).length : 0; },
    resetAll() {
      TC.track('clear-all-changes', 'Cleared all browser edits');
      NAMES.forEach(n => TC.storage.remove(KEY_OVR(n)));
      this.emit();
    },
    onChange(fn) { this.listeners.push(fn); },
    emit() { this.listeners.forEach(fn => fn()); },

    /** Figures out which dataset a parsed JSON object is. */
    detect(obj, filename) {
      if (!obj || typeof obj !== 'object') return null;
      if (obj.tc_bundle) return 'bundle';
      if (Array.isArray(obj.models)) return 'models';
      if (Array.isArray(obj.gpus)) return 'gpus';
      if (Array.isArray(obj.servers)) return 'servers';
      if (Array.isArray(obj.benchmarks)) return 'benchmarks';
      if (obj.onprem && obj.power) return 'assumptions';
      const base = (filename || '').toLowerCase().replace(/\.json$/, '');
      return NAMES.includes(base) ? base : null;
    },

    validate(name, obj) {
      const errs = [];
      const listKey = { models: 'models', gpus: 'gpus', servers: 'servers', benchmarks: 'benchmarks' }[name];
      if (listKey) {
        if (!Array.isArray(obj[listKey])) errs.push(`"${listKey}" must be an array`);
        else {
          const ids = new Set();
          obj[listKey].forEach((r, i) => {
            if (name !== 'benchmarks') {
              if (!r.id) errs.push(`${listKey}[${i}] has no id`);
              else if (ids.has(r.id)) errs.push(`duplicate id "${r.id}"`);
              ids.add(r.id);
            }
          });
        }
      }
      if (name === 'assumptions') {
        ['power', 'onprem', 'throughput', 'cloud'].forEach(k => { if (!obj[k]) errs.push(`missing "${k}" section`); });
      }
      return errs;
    },

    /** Imports one file (single dataset or bundle). Returns a message. */
    async importFile(file) {
      const text = await file.text();
      let obj;
      try { obj = JSON.parse(text); } catch (e) { throw new Error(`${file.name}: not valid JSON (${e.message})`); }
      const kind = this.detect(obj, file.name);
      if (!kind) throw new Error(`${file.name}: could not tell which dataset this is`);
      if (kind === 'bundle') {
        const done = [];
        NAMES.forEach(n => {
          if (obj.datasets && obj.datasets[n]) {
            const errs = this.validate(n, obj.datasets[n]);
            if (errs.length) throw new Error(`${file.name} → ${n}: ${errs.join('; ')}`);
            this.importDataset(n, obj.datasets[n]);
            done.push(n);
          }
        });
        return `Imported ${done.join(', ')} from bundle`;
      }
      const errs = this.validate(kind, obj);
      if (errs.length) throw new Error(`${file.name}: ${errs.join('; ')}`);
      this.importDataset(kind, obj);
      return `Imported ${kind}`;
    },

    /**
     * Imported data becomes the base when nothing was loaded from disk (file:// mode),
     * otherwise it is saved as an override on top of the files.
     */
    importDataset(name, obj) {
      if (!this.defaults[name] || this.source[name] === 'missing') {
        this.defaults[name] = obj;
        this.source[name] = 'imported';
        TC.storage.set(KEY_CACHE(name), obj);
        this.emit();
      } else {
        this.setOverride(name, obj);
      }
    },

    /**
     * What a browser override changed relative to the file defaults.
     * Returns [{ kind: 'changed'|'added'|'removed', label, index, changes: [{ path, from, to }] }].
     */
    diff(name) {
      const ovr = TC.storage.get(KEY_OVR(name));
      const base = this.defaults[name];
      if (!ovr || !base) return [];
      const strip = o => JSON.stringify(o, (k, val) => (k === 'original' ? undefined : val));
      // path = editor path (array indexes); label = readable (array items named by provider/name/id).
      const nice = k => String(k).replace(/_per_m$/, ' per 1M').replace(/_usd$/, ' (USD)').replace(/_pct$/, ' %').replace(/_/g, ' ');
      const walk = (a, b, path, label, out) => {
        if (strip(a) === strip(b)) return;
        const wa = TC.isWrapped(a), wb = TC.isWrapped(b);
        if (wa || wb || !a || !b || typeof a !== 'object' || typeof b !== 'object') {
          const from = TC.v(a), to = TC.v(b);
          out.push({ path, label, from, to, note: from === to ? 'source or status edited' : from === undefined ? 'added' : to === undefined ? 'removed' : '' });
          return;
        }
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        keys.forEach(k => {
          if (k === 'original') return;
          const item = Array.isArray(b) ? b[k] || a[k] : null;
          const part = item ? (item.provider || item.name || item.id || '#' + (Number(k) + 1)) : nice(k);
          walk(a[k], b[k], path ? path + '.' + k : String(k), label ? label + ' › ' + part : part, out);
        });
      };
      const listKey = { models: 'models', gpus: 'gpus', servers: 'servers', benchmarks: 'benchmarks' }[name];
      if (!listKey) {
        const out = [];
        walk(base, ovr, '', '', out);
        return out.length ? [{ kind: 'changed', label: 'Global assumptions', index: null, changes: out }] : [];
      }
      const keyOf = r => r.id || [r.gpu_id, r.model_id, r.precision, 'TP' + r.tp, r.pp > 1 ? 'PP' + r.pp : ''].filter(Boolean).join(' · ');
      const labelOf = r => (name === 'servers' ? `${r.vendor} ${r.sku} (${r.gpu_id})` : r.name || keyOf(r));
      const baseBy = new Map((base[listKey] || []).map(r => [keyOf(r), r]));
      const seen = new Set();
      const items = [];
      (ovr[listKey] || []).forEach((r, i) => {
        const k = keyOf(r);
        seen.add(k);
        const b = baseBy.get(k);
        if (!b) { items.push({ kind: 'added', label: labelOf(r), index: i, changes: [] }); return; }
        const out = [];
        walk(b, r, '', '', out);
        if (out.length) items.push({ kind: 'changed', label: labelOf(r), index: i, changes: out });
      });
      baseBy.forEach((r, k) => { if (!seen.has(k)) items.push({ kind: 'removed', label: labelOf(r), index: null, changes: [] }); });
      return items;
    },

    exportDataset(name) {
      TC.download(name + '.json', this.get(name));
    },
    exportBundle() {
      const b = { tc_bundle: 1, exported: new Date().toISOString(), datasets: this.all() };
      TC.download('token-calculator-data-' + TC.today() + '.json', b);
    },
  });
})();
