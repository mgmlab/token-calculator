/* Re-checks every worked example in data/examples.json against today's data and records the result in
   data/price-status.json ("examples"), so the app header can flag an example whose verdict changed.
   Runs after the daily price update (Node, no dependencies):  node scripts/check_examples.js  */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const json = f => JSON.parse(read(f));

// Load the calculation code exactly as the browser does, into a sandbox that stands in for `window`.
const ctx = { console, Math, Date, JSON, Intl, Number, String, Array, Object, Map, Set, isFinite, isNaN, parseFloat, parseInt };
ctx.window = ctx;
vm.createContext(ctx);
['js/config.js', 'js/util.js', 'js/data-store.js', 'js/exclusions.js', 'js/workload.js', 'js/engines/onprem.js', 'js/engines/cloud.js',
  'js/engines/api.js', 'js/engines/hybrid.js', 'js/summary.js', 'js/breakeven.js', 'js/examples.js']
  .forEach(f => vm.runInContext(read(f), ctx, { filename: f }));
const TC = ctx.TC;

const base = {};
['models', 'gpus', 'servers', 'benchmarks', 'assumptions'].forEach(n => { base[n] = json('data/' + n + '.json'); });
const examples = json('data/examples.json').examples;

const results = examples.map(ex => {
  try {
    const r = TC.evaluateExample(ex, base);
    return { id: ex.id, name: ex.name, expected: ex.expect, got: r.key, label: r.label, ok: r.ok };
  } catch (e) {
    return { id: ex.id, name: ex.name, expected: ex.expect, got: 'error', label: String(e.message || e).slice(0, 200), ok: false };
  }
});
const mismatches = results.filter(r => !r.ok);

const statusFile = path.join(ROOT, 'data/price-status.json');
const status = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, 'utf8')) : {};
status.examples = { checked: results.length, mismatches };
fs.writeFileSync(statusFile, JSON.stringify(status, null, 2) + '\n');

results.forEach(r => console.log(`${r.ok ? 'ok  ' : 'FLAG'} ${r.id}: expected ${r.expected}, got ${r.got} (${r.label})`));
console.log(`${results.length - mismatches.length}/${results.length} examples match their expected verdict.`);
