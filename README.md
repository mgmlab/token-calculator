# AI Token Calculator

Internal, vendor-neutral calculator for the Pellera AI team. It takes one workload profile and compares three options side by side:

- **Self-hosted on-prem**: GPU sizing in model replicas, server count, and total cost of ownership (the main focus).
- **GPU cloud**: reserved and on-demand.
- **Public API**: per-token pricing, both for the same open-weight model and for closed models as a reference.

It is a static HTML/JS app with no backend and no build step. All tunable numbers live in JSON files under [`data/`](data/), so they can be edited without touching code.

**Live site:** https://mgmlab.github.io/token-calculator/ (GitHub Pages from `main`; every push to `main` goes live in a minute or two). It is public, so don't put client names or confidential pricing in the committed data files. Before pushing code changes, run `sh release.sh` so browsers pick up the new CSS/JS immediately instead of using a cached copy (data-file changes don't need it).

**Maintainers:** Darren Livingston & Brad Ramsey, Pellera Technologies. Send questions, comments and change requests to them, or use **Request a change** in the app header.

© 2026 Darren Livingston & Brad Ramsey – Pellera Technologies. Internal use.

---

## Run it locally

Browsers block `fetch()` of local files when a page is opened from disk (`file://`), so serve the folder over HTTP. From this folder:

```bash
python serve.py
```

Then open <http://localhost:8000>.

`serve.py` is plain `http.server` with caching turned off, so edits to `/data` and `/js` show up on a normal refresh. The standard one-liner works too, but you may need a hard refresh (Ctrl+Shift+R) after editing files:

```bash
python -m http.server 8000
```

**Opening `index.html` directly (file://).** The app still loads. It shows a banner and lets you **import the JSON files** from `data/` (you can select all five at once). It also reuses the copy cached by the last time you ran it through a server, in that same browser.

---

## What's on screen

| Tab | What it does |
|---|---|
| **Compare** | Workload inputs on the left; each has a **?** tooltip explaining it, with a link to the [client input guide](docs/workload-guide.html). Results for on-prem (one row per server SKU), GPU cloud and API on the right. Click any row for **show the math**: every step, formula and intermediate value, the layouts evaluated, and the source/as-of/status of every data value used. |
| **Breakeven** | Scales users and peak concurrency from 0.02× up to 2,000× your profile and plots the monthly cost of the cheapest option in each category. Reports the volume at which on-prem becomes cheaper. |
| **Data editor** | Edit any dataset in a form or as raw JSON. Import and export JSON, reset to the file defaults. |
| **Method & assumptions** | Every formula as implemented, plus the throughput caveats. |

Badges you'll see:

- <kbd>measured benchmark</kbd> / <kbd>theoretical estimate</kbd>: where a row's throughput number came from. The **theoretical bandwidth-based estimate** is a roofline upper bound, not a measurement.
- <kbd>⚠ n</kbd>: the result depends on *n* **placeholder** values (low confidence; replace them with quotes or measurements).
- <kbd>! n</kbd>: warnings, e.g. the latency target can't be met, a max-context request doesn't fit, or pipeline parallelism across nodes is required.

### Exporting results

On the **Compare** tab:

- **CSV** (on each table): downloads that table. Opens in Excel.
- **Export CSV**: downloads every table plus the workload profile in one file.
- **Export PowerPoint**: builds a 16:9 Pellera-branded deck. The slides are:
  - title
  - workload profile
  - summary (lowest cost per category, with a chart)
  - on-prem, GPU cloud and API tables (split across slides as needed)
  - breakeven chart and crossovers
  - key assumptions with sources
  - how to read the results (caveats)
  - method
  - contacts

  The charts are native PowerPoint charts, so they stay editable. The PowerPoint library loads from jsDelivr the first time you export, so that step needs internet access.

### Change requests

**Request a change** (header or footer) opens a short form: request type, summary, details, source link, and optionally the current workload inputs. **Open email** starts an email to the maintainers with everything filled in, so they're notified. **Copy text** is there for Teams or other channels.

Recipients are set in [`js/config.js`](js/config.js) (`contacts`). The credit and copyright text shown in the footer, the PowerPoint and the guide also lives there.

---

## Data files

| File | Contents |
|---|---|
| `data/models.json` | Model catalog: params (total and active for MoE), layers, attention/KV heads, head dim, max context, KV layout (standard / sliding-window / MLA), and API prices by provider (USD per 1M tokens). `self_hostable: false` marks API-only reference models. |
| `data/gpus.json` | GPUs: memory, HBM bandwidth, power, dense TFLOPS, street price, and `cloud[]` rates per provider (on-demand and reserved $/GPU-hour). |
| `data/servers.json` | On-prem SKUs (Dell, HPE, Cisco, Lenovo, Supermicro). Each entry is one SKU + GPU config: GPUs per node, price, and node power. |
| `data/benchmarks.json` | Measured throughput per replica (GPU × model × precision × TP × PP), with the engine, sequence lengths and concurrency it was measured at. |
| `data/assumptions.json` | PUE, $/kWh, load factor, support %, memory overhead %, network/storage allowance, optional cost lines (colo, software, ops FTE, financing, residual value), theoretical-estimate efficiencies, and the default workload. |

### Every number carries its provenance

```json
"memory_gb": { "value": 141, "source": "NVIDIA H200 datasheet", "as_of": "2026-09-28", "status": "estimate" }
```

`status` is one of:

- `estimate`: from a public source on the `as_of` date. **All seeded values are estimates.**
- `placeholder`: low confidence; replace with a quote or measurement. Server prices, GPU street prices, support %, load factor and the theoretical-estimate efficiencies all start as placeholders.
- `override`: edited in the Data editor. The previous value is kept under `"original"`, and the **Revert** button restores it.

Plain values without a wrapper (ids, names, `gpus_per_node`, enum settings) are configuration, not sourced figures.

### Updating data: two ways

1. **In the app (no git needed).** Open **Data editor**, change values, and they are saved **in your browser only** as overrides. The files on disk never change. To share a change: click **Export \<file\>.json**, replace the file in `data/`, and commit. **Export all** saves a single bundle file that anyone can import.
2. **Edit the JSON directly.** Change `data/*.json` in any editor, update `source` and `as_of`, set `status`, then commit. Reload the app. If you had browser overrides for that file, click **Reset to file defaults** to see the file's values.

### Refreshing models and pricing (checklist)

Prices change often, so re-check them at least quarterly. Update `value`, `source` and `as_of` for each item.

| What | Where it lives | Where to check |
|---|---|---|
| API prices, closed models | `models.json` → `api_prices` on the `self_hostable: false` models | [OpenAI](https://developers.openai.com/api/docs/pricing) · [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) · [Google Gemini](https://ai.google.dev/gemini-api/docs/pricing) · [DeepSeek](https://api-docs.deepseek.com/quick_start/pricing) |
| API prices, hosted open models | `models.json` → `api_prices` on each open model | [Together AI](https://www.together.ai/pricing) · [Fireworks](https://docs.fireworks.ai/serverless/pricing) · [Amazon Bedrock](https://aws.amazon.com/bedrock/pricing/) |
| New open model | `models.json`: new record | Model card + `config.json` on Hugging Face: `num_hidden_layers`, `num_attention_heads`, `num_key_value_heads`, `head_dim`, `max_position_embeddings`, and `sliding_window`/`layer_types` or `kv_lora_rank` if present |
| GPU cloud rates | `gpus.json` → `cloud[]` | [Lambda](https://lambda.ai/pricing) · [CoreWeave](https://www.coreweave.com/pricing) · [Together](https://www.together.ai/pricing) · [AWS Capacity Blocks](https://aws.amazon.com/ec2/capacityblocks/pricing/) |
| GPU specs | `gpus.json` | Vendor datasheets (memory, bandwidth, TDP, dense TFLOPS) |
| Server prices | `servers.json` → `price_usd` | Current distributor/OEM quotes (set `status` to `estimate` once quoted) |

**Adding a new closed model** (e.g. a new GPT or Claude release): in the Data editor, open **Models**, select a similar closed model, click **Duplicate**, then change `id`, `name` and the prices. Export `models.json`, replace the file in `data/` and commit.

**Adding a new open model:** duplicate an open model with the same attention type (dense → Llama; MoE → Qwen3 235B; sliding window → gpt-oss; MLA → DeepSeek V3). Update the architecture fields from its `config.json`, then add `api_prices` for providers that host it.

### Adding a benchmark

Add a row to `data/benchmarks.json` (or use the Data editor → Benchmarks → Duplicate):

```json
{
  "gpu_id": "h100-sxm", "model_id": "llama-3.3-70b", "precision": "FP8", "tp": 4, "pp": 1,
  "engine": "vLLM", "engine_version": "0.x", "input_len": 1500, "output_len": 400, "concurrency": 64,
  "aggregate_output_tps":   { "value": 1234, "source": "our run, <link>", "as_of": "2026-10-01", "status": "estimate" },
  "per_request_output_tps": { "value": 21,   "source": "our run, <link>", "as_of": "2026-10-01", "status": "estimate" }
}
```

A row is used only when `gpu_id`, `model_id`, `precision`, `tp` and `pp` match exactly. When any layout has a measured benchmark, only benchmarked layouts are considered. Measure with realistic input/output lengths and concurrency, for example with vLLM `benchmark_serving`, TensorRT-LLM `trtllm-bench` or SGLang `bench_serving`. The seed file ships one **empty example row on purpose**: no benchmark figures were invented.

### Adding a model, GPU or server

Duplicate a similar record in the Data editor (or copy a block in the JSON), then change the `id` and values. Things to keep consistent:

- `servers[].gpu_id` must match a `gpus[].id`.
- `benchmarks[].model_id` / `gpu_id` must match existing ids.
- For **MoE** models, set `params_active_b`. For **sliding-window** or **MLA** attention, set `kv_layout` (see gpt-oss and DeepSeek V3 for examples).

---

## How the numbers work (short version)

The full formulas are in the **Method & assumptions** tab.

1. **Tokens.** Requests per day × active days × average input/output tokens gives monthly and term volume.
2. **Replica memory.**
   - Weights = params × bytes per param (FP16 = 2, FP8 = 1, INT4 = 0.5).
   - KV per request = 2 × layers × KV heads × head dim × KV bytes × sequence length.
   - Usable memory per replica = TP × GPU memory ÷ (1 + overhead). The KV cache gets whatever the weights leave.
3. **Layouts.** Every valid TP size (1/2/4/8, must divide the attention heads and fit in one node) is evaluated. If nothing fits in one node, 2- or 4-way pipeline parallelism across nodes is tried.
4. **Replicas.**
   - The minimum is the largest of three counts: enough for memory, enough for throughput (benchmark or theoretical estimate), and enough to hold the per-request speed target.
   - Headroom % is then added, plus one spare replica if N+1 is on.
5. **Nodes.** Replicas never span nodes, so nodes = ceil(replicas ÷ replicas per node).
6. **Cost.**
   - On-prem = servers + network/storage + support + power (+ optional colo, software, ops, financing, minus residual value).
   - Cloud = billed GPUs × $/GPU-hour × hours.
   - API = tokens × price, with optional cache and batch discounts.
7. **$ per 1M tokens** = total cost over term ÷ total tokens over term.

### Why on-prem can look expensive at low volume

Self-hosted capacity is sized for **peak** concurrency and paid for 24/7. API pricing follows volume, because the provider pools many customers. So the comparison mostly comes down to **average utilization**, which every on-prem and cloud row now shows.

Peak concurrency defaults to **derived from the traffic pattern**: busy-hour share plus a Poisson burst allowance. Bursts shrink relative to the average as volume grows, so utilization rises and on-prem becomes cheaper at scale.

With the default business-hours example, on-prem beats the same-model API above roughly 12B tokens/month. Flatter 24/7 traffic crosses over much earlier. A manually entered peak scales linearly in the breakeven sweep, which keeps utilization flat and can hide the crossover.

### Known limitations: read before quoting

- **Throughput is the least certain input.** It depends on batch size, sequence lengths, inference engine and version, quantization kernels and interconnect. Theoretical rows are optimistic. Replace them with measured benchmarks.
- **Time to first token isn't modeled.** The theoretical estimate charges prefill FLOPs to throughput, but there is no time-to-first-token target. The app warns when input:output > 10:1.
- **The peak-to-average ratio decides the breakeven.** On-prem and reserved capacity are sized for peak and paid for 24/7, while API cost follows volume.
- **API prices are held flat** over the term. Cache-write premiums aren't modeled, and regional/data-residency uplifts are excluded.
- **Cloud excludes** storage, egress and support plans. Published "reserved" rates are often short-term (≤ 1 yr); multi-year commitments are usually quoted lower.
- **Seeded prices are public list prices** or placeholders as of the `as_of` dates, not Pellera or partner pricing.

---

## Tests

With the server running, open <http://localhost:8000/tests/>. The engine tests use fixed fixtures with hand-computed expected values: KV formulas, layout selection, node rounding, cost components, API and cloud math.

## Project layout

```
index.html              app shell and the Method tab
css/styles.css
js/util.js              helpers, formatting, provenance tracking
js/data-store.js        load /data, browser overrides, import/export
js/workload.js          token volumes
js/engines/onprem.js    KV cache, layouts, replicas, nodes, TCO
js/engines/cloud.js     GPU cloud reserved / on-demand
js/engines/api.js       API pricing
js/breakeven.js         scale sweep and crossover detection
js/ui/*.js              inputs (+ tooltips), results tables, show-the-math, chart, data editor,
                        export (CSV / PowerPoint), request (change-request dialog)
js/config.js            credits, copyright, change-request recipients
docs/workload-guide.html  how to gather workload inputs from a client
assets/                 Pellera logo and favicon
data/*.json             tunable data (edit these)
tests/                  browser-run engine tests
serve.py                no-cache local server
```

All scripts are classic `<script>` files (not ES modules), so the app also works from `file://`.
