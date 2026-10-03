/*
 * Storage adapter for the admin console: everything that reads or writes the shared data goes through TC.repo.
 * Today it talks to GitHub (the repo that hosts the site); moving to Azure means replacing this one file with an
 * adapter that has the same methods (e.g. Azure Static Web Apps + Functions with Entra ID sign-in). Nothing else in
 * the console needs to change.
 *
 *   TC.repo.signedIn()            -> bool
 *   TC.repo.whoami()              -> { login, name, avatar, canWrite }
 *   TC.repo.readJson(path)        -> latest committed JSON (not the possibly-cached published copy)
 *   TC.repo.commit(files, msg)    -> one commit with every file in [{ path, json }]
 *   TC.repo.history(n, path)      -> recent changes [{ sha, message, author, date, url }]
 *   TC.repo.runPriceCheck()       -> start the daily price job now
 *   TC.repo.priceRuns(n)          -> recent price-job runs [{ status, conclusion, created, url }]
 */
(function () {
  const TC = window.TC;
  const CFG = { owner: 'mgmlab', repo: 'token-calculator', branch: 'main', workflow: 'update-prices.yml' };
  const API = 'https://api.github.com';
  const KEY = 'tc.admin.token';

  const store = {
    get() { try { return sessionStorage.getItem(KEY) || localStorage.getItem(KEY) || ''; } catch (e) { return ''; } },
    set(t, remember) {
      try {
        sessionStorage.setItem(KEY, t);
        if (remember) localStorage.setItem(KEY, t); else localStorage.removeItem(KEY);
      } catch (e) { /* storage blocked: token lives only for this page */ }
      mem = t;
    },
    clear() { try { sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); } catch (e) { /* ignore */ } mem = ''; },
  };
  let mem = '';
  const token = () => mem || store.get();

  async function api(path, opts) {
    const o = Object.assign({ method: 'GET' }, opts || {});
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (token()) headers.Authorization = 'Bearer ' + token();
    if (o.body && typeof o.body !== 'string') { headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(o.body); }
    const res = await fetch(API + path, Object.assign(o, { headers, cache: 'no-store' }));
    if (res.status === 204) return null;
    const txt = await res.text();
    const json = txt ? JSON.parse(txt) : null;
    if (!res.ok) {
      const msg = (json && json.message) || res.statusText;
      const err = new Error(res.status === 401 ? 'The access token was rejected (expired or mistyped). Paste a new one under Settings.'
        : res.status === 403 && /rate limit/i.test(msg) ? 'GitHub’s hourly limit for unsigned requests was reached. Add your access token under Settings.'
        : res.status === 403 || res.status === 404 ? `GitHub refused the request (${msg}). Check the token has access to ${CFG.owner}/${CFG.repo} with Contents and Actions set to “Read and write”.`
        : `GitHub error ${res.status}: ${msg}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }
  const R = () => `/repos/${CFG.owner}/${CFG.repo}`;
  // UTF-8 safe base64 in both directions (data files contain ×, –, ’ …)
  const b64decode = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), c => c.charCodeAt(0)));

  TC.repo = {
    config: CFG,
    signedIn: () => !!token(),
    setToken: (t, remember) => store.set(t.trim(), remember),
    signOut: () => store.clear(),
    remembered: () => { try { return !!localStorage.getItem(KEY); } catch (e) { return false; } },

    async whoami() {
      const [u, r] = await Promise.all([api('/user'), api(R())]);
      return { login: u.login, name: u.name || u.login, avatar: u.avatar_url, canWrite: !!(r.permissions && (r.permissions.push || r.permissions.admin)) };
    },

    async readJson(path) {
      const f = await api(`${R()}/contents/${path}?ref=${CFG.branch}`);
      return JSON.parse(b64decode(f.content));
    },

    /** One commit containing every file, so a publish is all-or-nothing and appears as a single entry in the history. */
    async commit(files, message) {
      const ref = await api(`${R()}/git/ref/heads/${CFG.branch}`);
      const head = await api(`${R()}/git/commits/${ref.object.sha}`);
      const tree = await api(`${R()}/git/trees`, { method: 'POST', body: {
        base_tree: head.tree.sha,
        tree: files.map(f => ({ path: f.path, mode: '100644', type: 'blob', content: typeof f.json === 'string' ? f.json : JSON.stringify(f.json, null, 2) + '\n' })),
      } });
      const commit = await api(`${R()}/git/commits`, { method: 'POST', body: { message, tree: tree.sha, parents: [ref.object.sha] } });
      await api(`${R()}/git/refs/heads/${CFG.branch}`, { method: 'PATCH', body: { sha: commit.sha } });
      // Publishing to Pages from a token-made commit can lag; ask for a build (ignored if not allowed).
      api(`${R()}/pages/builds`, { method: 'POST' }).catch(() => {});
      return { sha: commit.sha, url: `https://github.com/${CFG.owner}/${CFG.repo}/commit/${commit.sha}` };
    },

    async history(n, path) {
      const list = await api(`${R()}/commits?sha=${CFG.branch}&per_page=${n || 20}${path ? '&path=' + encodeURIComponent(path) : ''}`);
      return list.map(c => ({
        sha: c.sha, message: c.commit.message, url: c.html_url,
        author: (c.author && c.author.login) || c.commit.author.name, avatar: c.author && c.author.avatar_url,
        date: c.commit.author.date,
      }));
    },

    async runPriceCheck(force) {
      await api(`${R()}/actions/workflows/${CFG.workflow}/dispatches`, { method: 'POST', body: { ref: CFG.branch, inputs: { force: !!force } } });
    },

    /**
     * Restore an earlier version as a NEW commit (history is never rewritten, so a restore can itself be undone).
     *   mode 'data' → only the data/ folder goes back to that version.
     *   mode 'all'  → everything goes back, except the admin console and the scheduled price job, which stay current
     *                 so you can always roll forward again (and no extra token permission is needed for workflows).
     */
    async restore(sha, mode, message) {
      const KEEP = p => p === 'admin.html' || p === 'css/admin.css' || p.startsWith('js/admin/') || p.startsWith('.github/');
      const ref = await api(`${R()}/git/ref/heads/${CFG.branch}`);
      const head = await api(`${R()}/git/commits/${ref.object.sha}`);
      const target = await api(`${R()}/git/commits/${sha}`);
      const list = async t => (await api(`${R()}/git/trees/${t}?recursive=1`)).tree.filter(e => e.type === 'blob');
      const [now, then] = await Promise.all([list(head.tree.sha), list(target.tree.sha)]);
      const pick = mode === 'data' ? (p => p.startsWith('data/')) : KEEP;
      const nowBy = new Map(now.map(e => [e.path, e])), thenBy = new Map(then.map(e => [e.path, e]));
      let base, entries = [];
      if (mode === 'data') {
        base = head.tree.sha;  // start from today, put the data folder back
        then.filter(e => pick(e.path)).forEach(e => entries.push({ path: e.path, mode: e.mode, type: 'blob', sha: e.sha }));
        now.filter(e => pick(e.path) && !thenBy.has(e.path)).forEach(e => entries.push({ path: e.path, mode: e.mode, type: 'blob', sha: null }));
      } else {
        base = target.tree.sha;  // start from then, keep today's console and price job
        now.filter(e => KEEP(e.path)).forEach(e => entries.push({ path: e.path, mode: e.mode, type: 'blob', sha: e.sha }));
        then.filter(e => KEEP(e.path) && !nowBy.has(e.path)).forEach(e => entries.push({ path: e.path, mode: e.mode, type: 'blob', sha: null }));
      }
      const tree = await api(`${R()}/git/trees`, { method: 'POST', body: { base_tree: base, tree: entries } });
      if (tree.sha === head.tree.sha) return { sha: null, url: null, unchanged: true };
      const commit = await api(`${R()}/git/commits`, { method: 'POST', body: { message, tree: tree.sha, parents: [ref.object.sha] } });
      await api(`${R()}/git/refs/heads/${CFG.branch}`, { method: 'PATCH', body: { sha: commit.sha } });
      api(`${R()}/pages/builds`, { method: 'POST' }).catch(() => {});
      return { sha: commit.sha, url: `https://github.com/${CFG.owner}/${CFG.repo}/commit/${commit.sha}` };
    },

    /** Named "known-good" versions (git tags). */
    async tags() {
      const list = await api(`${R()}/tags?per_page=20`);
      return Promise.all(list.map(async t => {
        let date = null;
        try { date = (await api(`${R()}/commits/${t.commit.sha}`)).commit.author.date; } catch (e) { /* ignore */ }
        return { name: t.name, sha: t.commit.sha, date };
      }));
    },
    async createTag(name, sha) {
      if (!sha) sha = (await api(`${R()}/git/ref/heads/${CFG.branch}`)).object.sha;
      await api(`${R()}/git/refs`, { method: 'POST', body: { ref: 'refs/tags/' + name, sha } });
      return sha;
    },
    /** A complete copy of the app and data at any version, as a zip download. */
    zipUrl: ref => `https://github.com/${CFG.owner}/${CFG.repo}/archive/${ref || CFG.branch}.zip`,

    async priceRuns(n) {
      const r = await api(`${R()}/actions/workflows/${CFG.workflow}/runs?per_page=${n || 5}`);
      return (r.workflow_runs || []).map(x => ({ id: x.id, status: x.status, conclusion: x.conclusion, created: x.created_at, event: x.event, url: x.html_url }));
    },
  };
})();
