/* Shared helpers. Classic script (not an ES module) so the app also runs from file://. */
(function () {
  const TC = (window.TC = window.TC || {});

  /** Unwrap a data value: {value, source, as_of, status} -> value; plain values pass through. */
  TC.v = function (x) {
    if (x && typeof x === 'object' && !Array.isArray(x) && 'value' in x) return x.value;
    return x;
  };

  TC.isWrapped = function (x) {
    return !!(x && typeof x === 'object' && !Array.isArray(x) && 'value' in x);
  };

  /**
   * Collects the data values an engine used, so every result can show its provenance
   * and flag placeholders.
   */
  TC.Provenance = class {
    constructor() { this.items = []; }
    use(label, x) {
      const val = TC.v(x);
      if (TC.isWrapped(x)) {
        this.items.push({ label, value: val, source: x.source || '', as_of: x.as_of || '', status: x.status || '' });
      } else {
        this.items.push({ label, value: val, source: 'Workload input', as_of: '', status: 'input' });
      }
      return val;
    }
    get placeholders() { return this.items.filter(i => i.status === 'placeholder'); }
    get overrides() { return this.items.filter(i => i.status === 'override'); }
  };

  /** A step in "show the math". */
  TC.step = function (label, formula, value, unit, note) {
    return { label, formula, value, unit: unit || '', note: note || '' };
  };

  TC.BYTES_PER_PARAM = { FP16: 2, BF16: 2, FP8: 1, INT4: 0.5 };

  TC.ceil = Math.ceil;
  TC.clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  // ---------- formatting
  const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const nf2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

  const nfCache = {};
  const nfd = d => nfCache[d] || (nfCache[d] = new Intl.NumberFormat('en-US', { maximumFractionDigits: d }));

  TC.fmt = {
    int: n => (n == null || !isFinite(n) ? '—' : nf0.format(n)),
    num: (n, d = 2) => (n == null || !isFinite(n) ? '—' : nfd(d).format(n)),
    usd: n => {
      if (n == null || !isFinite(n)) return '—';
      if (Math.abs(n) >= 100) return '$' + nf0.format(n);
      return '$' + nf2.format(n);
    },
    usdCompact: n => {
      if (n == null || !isFinite(n)) return '—';
      const a = Math.abs(n);
      if (a >= 1e9) return '$' + nf2.format(n / 1e9) + 'B';
      if (a >= 1e6) return '$' + nf2.format(n / 1e6) + 'M';
      if (a >= 1e3) return '$' + nf2.format(n / 1e3) + 'K';
      return '$' + nf2.format(n);
    },
    perM: n => {
      if (n == null || !isFinite(n)) return '—';
      if (n < 0.1) return '$' + n.toFixed(4);
      if (n < 10) return '$' + n.toFixed(3);
      return '$' + nf2.format(n);
    },
    tokens: n => {
      if (n == null || !isFinite(n)) return '—';
      const a = Math.abs(n);
      if (a >= 1e12) return nf2.format(n / 1e12) + 'T';
      if (a >= 1e9) return nf2.format(n / 1e9) + 'B';
      if (a >= 1e6) return nf2.format(n / 1e6) + 'M';
      if (a >= 1e3) return nf2.format(n / 1e3) + 'K';
      return nf0.format(n);
    },
    price: n => (n == null || !isFinite(n) ? '—' : '$' + (n < 0.1 ? n.toFixed(4) : n.toFixed(2))),
    gb: n => (n == null || !isFinite(n) ? '—' : nf2.format(n) + ' GB'),
    bytes: n => {
      if (n == null || !isFinite(n)) return '—';
      if (n >= 1e9) return nf2.format(n / 1e9) + ' GB';
      if (n >= 1e6) return nf2.format(n / 1e6) + ' MB';
      if (n >= 1e3) return nf2.format(n / 1e3) + ' KB';
      return nf0.format(n) + ' B';
    },
  };

  TC.today = () => new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD

  TC.esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  TC.clone = o => JSON.parse(JSON.stringify(o));

  TC.download = function (filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2) + '\n'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  };

  TC.storage = {
    get(key) {
      try { const s = localStorage.getItem(key); return s == null ? null : JSON.parse(s); } catch (e) { return null; }
    },
    set(key, val) {
      try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
    },
  };
})();
