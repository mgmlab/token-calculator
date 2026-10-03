/* Runs tests/engines.test.js in Node (no dependencies) so the engine tests also run on every push:  node scripts/run_tests.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const ctx = { console, Math, Date, JSON, Intl, Number, String, Array, Object, Map, Set, isFinite, isNaN, parseFloat, parseInt };
ctx.window = ctx;
vm.createContext(ctx);
// Same scripts, same order as tests/index.html.
['js/util.js', 'js/data-store.js', 'js/workload.js', 'js/exclusions.js', 'js/engines/onprem.js', 'js/engines/cloud.js', 'js/engines/api.js',
  'js/breakeven.js', 'js/engines/hybrid.js', 'js/summary.js', 'js/examples.js', 'tests/engines.test.js']
  .forEach(f => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f }));

const results = ctx.TC_TEST_RESULTS || [];
results.forEach(r => console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.msg ? ' - ' + r.msg : ''}`));
const failed = results.filter(r => !r.ok).length;
console.log(`${results.length - failed} / ${results.length} passed`);
process.exit(failed || !results.length ? 1 : 0);
