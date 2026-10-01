/* Worked examples (data/examples.json): building an example's inputs and checking its verdict.
   Shared by the app ("Load an example"), the tests page and scripts/check_examples.js (daily check). */
(function () {
  const TC = window.TC;

  /** Workload inputs for an example: the workload defaults, then the example's own inputs. */
  TC.exampleWorkload = function (ex, defaults) {
    return Object.assign({}, defaults, TC.clone(ex.workload), { scenario_name: 'Example: ' + ex.name, _example: ex.id });
  };

  /** Runs an example against base datasets (the shared files) and returns its verdict. Pure: no browser state. */
  TC.evaluateExample = function (ex, base) {
    const data = {};
    Object.keys(base).forEach(n => {
      const p = ex.data && ex.data[n];
      data[n] = p ? TC.patchDataset(n, base[n], p) : base[n];
    });
    const defaults = TC.clone((data.assumptions && data.assumptions.workload_defaults) || {});
    delete defaults._note;
    const w = TC.exampleWorkload(ex, defaults);
    const res = TC.computeAll(data, w);
    const x = TC.execSummary(data, res.w, res);
    return { key: x.verdict.key, label: x.verdict.label, ok: x.verdict.key === ex.expect };
  };
})();
