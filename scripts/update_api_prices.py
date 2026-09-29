"""Weekly API price update from OpenRouter's public model list (no API key needed).

Only price rows in data/models.json that carry a "feed" block are touched:
  "feed": {"source": "openrouter", "id": "<openrouter model id>", "mode": "mirror" | "own"}
    mirror = the row is a first-party provider (e.g. Anthropic) whose list price OpenRouter passes through
    own    = the row is OpenRouter itself (its lowest routed price for an open model)

Safety: a price that moves more than MAX_CHANGE (default 50%) is NOT applied; it is listed under
"needs review" in the run summary and in data/models.json → prices_checked. Re-run the workflow
with "force" to accept such changes. Models missing from the feed are left unchanged and reported.

Usage:  python scripts/update_api_prices.py [--force] [--dry-run]
Stdlib only, so it runs as-is on GitHub Actions or any machine with Python 3.8+.
"""
import datetime
import json
import os
import sys
import urllib.request

FEED_URL = 'https://openrouter.ai/api/v1/models'
MAX_CHANGE = 0.50
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS = os.path.join(ROOT, 'data', 'models.json')


def per_million(x):
    if x in (None, ''):
        return None
    v = float(x) * 1e6
    return float(f'{v:.6g}') if v > 0 else None


def fetch_feed():
    req = urllib.request.Request(FEED_URL, headers={'User-Agent': 'pellera-token-calculator-price-update'})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.load(r)['data']
    return {m['id']: m for m in data}


def batch_discount(feed, fid, prompt, completion):
    """Batch discount % if the feed lists a ':batch' variant with a consistent discount on input and output."""
    b = feed.get(fid + ':batch')
    if not b or not prompt or not completion:
        return None
    bp, bc = per_million(b['pricing'].get('prompt')), per_million(b['pricing'].get('completion'))
    if not bp or not bc:
        return None
    d_in, d_out = 1 - bp / prompt, 1 - bc / completion
    if not (0 < d_in < 1 and 0 < d_out < 1) or abs(d_in - d_out) > 0.02:
        return None
    return round(d_in * 100)


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')  # Windows consoles default to cp1252
    force = '--force' in sys.argv
    dry = '--dry-run' in sys.argv
    today = datetime.date.today().isoformat()
    doc = json.load(open(MODELS, encoding='utf-8'))
    feed = fetch_feed()

    changed, review, missing, checked = [], [], [], 0
    for model in doc['models']:
        for row in model.get('api_prices', []):
            fd = row.get('feed')
            if not fd or fd.get('source') != 'openrouter':
                continue
            checked += 1
            fid = fd['id']
            m = feed.get(fid)
            if not m:
                missing.append(f"{model['name']} / {row['provider']} ({fid})")
                continue
            pr = m['pricing']
            new = {
                'input_per_m': per_million(pr.get('prompt')),
                'output_per_m': per_million(pr.get('completion')),
                'cached_input_per_m': per_million(pr.get('input_cache_read')),
            }
            new['batch_discount_pct'] = batch_discount(feed, fid, new['input_per_m'], new['output_per_m'])
            if fd.get('mode') == 'mirror':
                src = f"{row['provider']} list price, checked via OpenRouter price feed ({fid})"
            else:
                src = f"openrouter.ai/api/v1/models ({fid})"

            for key, val in new.items():
                if val is None:
                    continue
                cur = row.get(key)
                old = cur.get('value') if isinstance(cur, dict) else None
                if old == val:
                    continue
                label = f"{model['name']} / {row['provider']} / {key}"
                if isinstance(old, (int, float)) and old > 0 and abs(val - old) / old > MAX_CHANGE and not force:
                    review.append(f"{label}: {old} → {val} (not applied; over {int(MAX_CHANGE * 100)}% change)")
                    continue
                row[key] = {'value': val, 'source': src, 'as_of': today, 'status': 'estimate'}
                changed.append(f"{label}: {old if old is not None else 'unset'} → {val}")

    doc['prices_checked'] = {
        'date': today,
        'source': 'OpenRouter public price list (' + FEED_URL + '), weekly GitHub Actions job',
        'rows_checked': checked,
        'values_changed': len(changed),
        'needs_review': review,
        'missing_from_feed': missing,
    }

    lines = [f'## API price update — {today}', '',
             f'Checked {checked} price rows against OpenRouter; {len(changed)} value(s) changed.', '']
    if changed:
        lines += ['### Changed'] + [f'- {c}' for c in changed] + ['']
    if review:
        lines += ['### Needs review (not applied)'] + [f'- {c}' for c in review] + ['',
                  'Re-run the "Update API prices" workflow with **force** checked to accept these.', '']
    if missing:
        lines += ['### Not found in the feed (left unchanged)'] + [f'- {c}' for c in missing] + ['']
    summary = '\n'.join(lines)
    print(summary)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as f:
            f.write(summary + '\n')
    for r in review:
        print(f'::warning title=Price change needs review::{r}')
    for m in missing:
        print(f'::warning title=Model missing from price feed::{m}')

    if not dry:
        with open(MODELS, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(doc, f, indent=2, ensure_ascii=False)
            f.write('\n')


if __name__ == '__main__':
    main()
