"""Daily price update for API (per-token) and GPU rental prices.

Every price row that carries a "feed" block is refreshed from its public source:

  data/models.json  api_prices[].feed
    {"source": "openrouter", "id": "...", "mode": "mirror"|"own"}   OpenRouter list price (mirror = equals first-party price)
    {"source": "openrouter-endpoint", "id": "...", "provider": "Together"}  one hosting provider's price via OpenRouter
    {"source": "fireworks", "model": "OpenAI GPT OSS 120B"} | {"source": "fireworks", "tier": "More than 16B parameters"}
    {"source": "deepseek", "column": 0|1}                              DeepSeek API docs, peak rates (0 = flash, 1 = pro)
    {"source": "azure-foundry", "input": "<meter>", "output": "<meter>", "region": "eastus2"}  Azure Retail Prices API (Foundry Models)
    {"source": "vertex", "model": "Llama 3.3 70B"}                     Vertex AI generative-AI pricing page (managed partner/open models)

  data/gpus.json  cloud[].feed
    {"source": "lambda", "name": "NVIDIA H100 SXM", "vram": "80 GB"}   on-demand, 8x instance table
    {"source": "coreweave", "name": "NVIDIA HGX H100"}                 instance price ÷ gpus_per_instance
    {"source": "nebius", "name": "NVIDIA HGX H100"}                    latest-effective on-demand column
    {"source": "together-gpu", "name": "HGX H100"}                     on-demand + 181+ day reserved
    {"source": "aws-capacity-blocks", "instance": "p5.48xlarge", "region": "US East (N. Virginia)"}
    {"source": "azure", "sku": "Standard_ND96isr_H100_v5", "region": "eastus2"}   pay-as-you-go + 1/3/5-yr reservations
    {"source": "google", "machine": "a3-highgpu-8g", "on_demand": "price"|"flex"}  us-central1 page default; CUD 1/3-yr

Safety:
  * A source that fails to download or parse leaves all of its rows unchanged; the failure is reported.
  * A value that moves more than MAX_CHANGE (50%) is held for review unless run with --force.
  * Rows without a feed are listed as "manual" so nothing is silently stale.

Writes data/models.json and data/gpus.json only when a price changes, and always writes
data/price-status.json (what was checked, what changed, what failed) for the app's header.

Usage: python scripts/update_prices.py [--force] [--dry-run]      (stdlib only)
"""
import datetime
import html
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

MAX_CHANGE = 0.50
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36'
HOURS = {1: 8760, 3: 26280, 5: 43800}


# ------------------------------------------------------------------ helpers
def get(url, tries=3):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Language': 'en-US'})
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.read().decode('utf-8', errors='ignore')
        except Exception as e:  # noqa: BLE001 - report any network error
            last = e
            time.sleep(3 * (i + 1))
    raise RuntimeError(f'download failed: {url}: {last}')


def page_text(raw):
    """HTML → flat text with ' | ' between elements, so table cells stay separable."""
    s = re.sub(r'<script[\s\S]*?</script>|<style[\s\S]*?</style>', ' ', raw)
    s = re.sub(r'<[^>]+>', ' | ', s)
    s = html.unescape(s).replace('\u200b', '')
    s = re.sub(r'(\s*\|\s*)+', ' | ', s)
    return re.sub(r'\s+', ' ', s)


def money(s):
    return float(s.replace(',', ''))


def per_m(x):
    if x in (None, ''):
        return None
    v = float(x) * 1e6
    return float(f'{v:.6g}') if v > 0 else None


def r4(x):
    return None if x is None else float(f'{x:.6g}')


NICE = {
    'input_per_m': 'input $/1M', 'output_per_m': 'output $/1M', 'cached_input_per_m': 'cached input $/1M',
    'batch_discount_pct': 'batch discount %', 'on_demand_per_gpu_hr': 'on-demand $/GPU-hr',
    'reserved_per_gpu_hr': 'reserved $/GPU-hr', 'reserved_terms_per_gpu_hr.1': '1-yr reserved $/GPU-hr',
    'reserved_terms_per_gpu_hr.3': '3-yr reserved $/GPU-hr', 'reserved_terms_per_gpu_hr.5': '5-yr reserved $/GPU-hr',
}


class SourceError(Exception):
    pass


# ------------------------------------------------------------------ sources (each loaded once, lazily)
class OpenRouter:
    name = 'OpenRouter'
    url = 'https://openrouter.ai/api/v1/models'

    def __init__(self):
        self.models = {m['id']: m for m in json.loads(get(self.url))['data']}
        self._endpoints = {}

    def batch_discount(self, fid, p_in, p_out):
        b = self.models.get(fid + ':batch')
        if not b or not p_in or not p_out:
            return None
        bi, bo = per_m(b['pricing'].get('prompt')), per_m(b['pricing'].get('completion'))
        if not bi or not bo:
            return None
        di, do = 1 - bi / p_in, 1 - bo / p_out
        return round(di * 100) if 0 < di < 1 and 0 < do < 1 and abs(di - do) <= 0.02 else None

    def model(self, fid, mirror=True):
        m = self.models.get(fid)
        if not m:
            raise SourceError(f'model {fid} not in OpenRouter list')
        p = m['pricing']
        out = {'input_per_m': per_m(p.get('prompt')), 'output_per_m': per_m(p.get('completion')),
               'cached_input_per_m': per_m(p.get('input_cache_read'))}
        # Batch discounts only mirror a first-party Batch API; OpenRouter's own batch variants are not comparable.
        if mirror:
            out['batch_discount_pct'] = self.batch_discount(fid, out['input_per_m'], out['output_per_m'])
        return out

    def endpoint(self, fid, provider):
        if fid not in self._endpoints:
            url = f'https://openrouter.ai/api/v1/models/{fid}/endpoints'
            self._endpoints[fid] = json.loads(get(url))['data']['endpoints']
        eps = [e for e in self._endpoints[fid] if e.get('provider_name') == provider]
        if not eps:
            raise SourceError(f'{provider} does not list {fid} on OpenRouter')
        e = min(eps, key=lambda x: float(x['pricing']['prompt']))
        p = e['pricing']
        return {'input_per_m': per_m(p.get('prompt')), 'output_per_m': per_m(p.get('completion')),
                'cached_input_per_m': per_m(p.get('input_cache_read'))}


class Fireworks:
    name = 'Fireworks'
    url = 'https://docs.fireworks.ai/serverless/pricing.md'

    def __init__(self):
        md = get(self.url)
        self.models, self.tiers = {}, {}
        for line in md.splitlines():
            cells = [c.strip() for c in line.strip().strip('|').split('|')]
            if len(cells) < 2:
                continue
            label = re.sub(r'\[([^\]]+)\]\([^)]*\)', r'\1', cells[0]).strip()
            prices = [money(x) for x in re.findall(r'\\?\$([\d.,]+)', cells[1])]
            if len(prices) == 3:
                self.models[label] = prices
            elif len(prices) == 1:
                self.tiers[label] = prices[0]
        m = re.search(r'Batch inference\*\* is billed at \*\*(\d+)% of serverless', md)
        self.batch = 100 - int(m.group(1)) if m else None
        if not self.models or not self.tiers:
            raise SourceError('Fireworks pricing table not found (page layout changed?)')

    def lookup(self, feed):
        if 'model' in feed:
            if feed['model'] not in self.models:
                raise SourceError(f"Fireworks model '{feed['model']}' not in pricing table")
            i, c, o = self.models[feed['model']]
            return {'input_per_m': i, 'cached_input_per_m': c, 'output_per_m': o, 'batch_discount_pct': self.batch}
        tier = next((v for k, v in self.tiers.items() if k.replace('–', '-') == feed['tier'].replace('–', '-')), None)
        if tier is None:
            raise SourceError(f"Fireworks size tier '{feed['tier']}' not found")
        return {'input_per_m': tier, 'output_per_m': tier, 'batch_discount_pct': self.batch}


class DeepSeek:
    name = 'DeepSeek'
    url = 'https://api-docs.deepseek.com/quick_start/pricing'

    def __init__(self):
        t = page_text(get(self.url))

        def peak(after):
            m = re.search(re.escape(after) + r'[\s\S]*?PEAK \| \$([\d.]+) \| \$([\d.]+) \| PEAK \| \$([\d.]+) \| \$([\d.]+)', t)
            if not m:
                raise SourceError(f'DeepSeek "{after}" row not found')
            return [float(m.group(3)), float(m.group(4))]  # second (PEAK) pair
        self.hit, self.miss, self.out = peak('(CACHE HIT)'), peak('(CACHE MISS)'), peak('OUTPUT TOKENS')

    def lookup(self, feed):
        c = feed['column']
        return {'input_per_m': self.miss[c], 'cached_input_per_m': self.hit[c], 'output_per_m': self.out[c]}


class AzureFoundry:
    """Azure AI Foundry serverless (pay-per-token) model prices from the public Azure Retail Prices API."""
    name = 'Azure AI Foundry'
    url = 'https://prices.azure.com/api/retail/prices'

    def __init__(self):
        self.cache = {}

    def meter(self, name, region):
        key = (name, region)
        if key not in self.cache:
            flt = f"serviceName eq 'Foundry Models' and armRegionName eq '{region}' and meterName eq '{name}'"
            items = json.loads(get(self.url + '?' + urllib.parse.urlencode({'$filter': flt})))['Items']
            items = [i for i in items if i.get('type') == 'Consumption']
            if not items:
                raise SourceError(f"Azure meter '{name}' in {region} not found")
            i = items[0]
            unit = {'1K': 1000, '1M': 1, '1': 1e6}.get(i['unitOfMeasure'])
            if unit is None:
                raise SourceError(f"Azure meter '{name}' has unexpected unit {i['unitOfMeasure']}")
            self.cache[key] = r4(i['retailPrice'] * unit)
        return self.cache[key]

    def lookup(self, feed):
        region = feed.get('region', 'eastus2')
        return {'input_per_m': self.meter(feed['input'], region), 'output_per_m': self.meter(feed['output'], region)}


class Vertex:
    """Google Vertex AI managed (Model-as-a-Service) prices for open/partner models."""
    name = 'Google Vertex AI'
    url = 'https://cloud.google.com/vertex-ai/generative-ai/pricing'

    def __init__(self):
        self.t = page_text(get(self.url))

    def lookup(self, feed):
        # Rows read: <model> | Input | $x | Output | $y [| Cache Hit | $c] [| Batch Input | $b | Batch Output | $bo]
        m = re.search(r'\| ' + re.escape(feed['model']) + r' \| Input \| \$([\d.]+) \| Output \| \$([\d.]+)'
                      r'(?: \| Cache Hit \| \$([\d.]+))?(?: \| Batch Input \| \$([\d.]+))?', self.t)
        if not m:
            raise SourceError(f"Vertex AI model '{feed['model']}' not found")
        inp, out = money(m.group(1)), money(m.group(2))
        vals = {'input_per_m': inp, 'output_per_m': out}
        if m.group(3):
            vals['cached_input_per_m'] = money(m.group(3))
        if m.group(4) and inp > 0:
            vals['batch_discount_pct'] = round(100 * (1 - money(m.group(4)) / inp))
        return vals


class Lambda:
    name = 'Lambda'
    url = 'https://lambda.ai/pricing'

    def __init__(self):
        self.t = page_text(get(self.url))

    def lookup(self, feed, offer):
        # The first matching row is the 8x-instance table (tabs are ordered 8x, 4x, 2x, 1x).
        m = re.search(re.escape(feed['name']) + r' \| ' + re.escape(feed['vram']) + r' \|[^$]*?\$([\d.,]+)', self.t)
        if not m:
            raise SourceError(f"Lambda row '{feed['name']} {feed['vram']}' not found")
        return {'on_demand_per_gpu_hr': money(m.group(1))}


class CoreWeave:
    name = 'CoreWeave'
    url = 'https://www.coreweave.com/pricing'

    def __init__(self):
        self.t = page_text(get(self.url))

    def lookup(self, feed, offer):
        m = re.search(re.escape(feed['name']) + r' \| On-Demand Price: \| \$([\d.,]+)', self.t)
        if not m:
            raise SourceError(f"CoreWeave '{feed['name']}' not found")
        return {'on_demand_per_gpu_hr': r4(money(m.group(1)) / offer['gpus_per_instance'])}


class Nebius:
    name = 'Nebius'
    url = 'https://nebius.com/prices'

    def __init__(self):
        self.t = page_text(get(self.url))

    def lookup(self, feed, offer):
        # Row: NAME | vCPUs | RAM | price [| price effective later]; the last column is the latest price.
        m = re.search(re.escape(feed['name']) + r' \| [\d\-]+ \| [\d\-]+ \| ((?:(?:from )?\$[\d.,]+ \| ?)+)', self.t)
        if not m:
            raise SourceError(f"Nebius '{feed['name']}' not found (or 'Contact us')")
        return {'on_demand_per_gpu_hr': money(re.findall(r'\$([\d.,]+)', m.group(1))[-1])}


class TogetherGPU:
    name = 'Together AI (GPU clusters)'
    url = 'https://www.together.ai/pricing'

    def __init__(self):
        self.t = page_text(get(self.url))
        i = self.t.find('181+ days')
        if i < 0:
            raise SourceError('Together reserved-capacity table not found')
        self.table = self.t[i:i + 3000]

    def lookup(self, feed, offer):
        # Columns: preemptible | on-demand | 7-30 d | 31-90 d | 91-180 d | 181+ d
        m = re.search(r'NVIDIA \| ' + re.escape(feed['name']) + r' \| ((?:\$[\d.,]+ \| ){2,6})', self.table)
        if not m:
            raise SourceError(f"Together '{feed['name']}' not found")
        p = [money(x) for x in re.findall(r'\$([\d.,]+)', m.group(1))]
        out = {'on_demand_per_gpu_hr': p[1]}
        if len(p) >= 6:
            out['reserved_per_gpu_hr'] = p[5]
        return out


class AWSCapacityBlocks:
    name = 'AWS Capacity Blocks'
    url = 'https://aws.amazon.com/ec2/capacityblocks/pricing/'

    def __init__(self):
        self.t = page_text(get(self.url))

    def lookup(self, feed, offer):
        m = re.search(re.escape(feed['instance']) + r' \| ' + re.escape(feed['region']) + r' \| \$[\d.,]+ USD \(\$([\d.,]+) USD\)', self.t)
        if not m:
            raise SourceError(f"AWS {feed['instance']} in {feed['region']} not found")
        return {'reserved_per_gpu_hr': money(m.group(1))}


class Azure:
    name = 'Azure'
    url = 'https://prices.azure.com/api/retail/prices'

    def __init__(self):
        self.cache = {}

    def lookup(self, feed, offer):
        key = (feed['sku'], feed['region'])
        if key not in self.cache:
            flt = f"armRegionName eq '{feed['region']}' and armSkuName eq '{feed['sku']}' and serviceName eq 'Virtual Machines'"
            items = json.loads(get(self.url + '?' + urllib.parse.urlencode({'$filter': flt})))['Items']
            self.cache[key] = [i for i in items if 'Windows' not in i['productName']
                               and 'Spot' not in i['skuName'] and 'Low Priority' not in i['skuName']]
        items, n = self.cache[key], offer['gpus_per_instance']
        out = {}
        for i in items:
            term = i.get('reservationTerm')
            if i['type'] == 'Consumption' and not term:
                out['on_demand_per_gpu_hr'] = r4(i['retailPrice'] / n)
            elif i['type'] == 'Reservation' and term:
                yrs = int(term.split()[0])
                if yrs in HOURS:
                    out[f'reserved_terms_per_gpu_hr.{yrs}'] = r4(i['retailPrice'] / HOURS[yrs] / n)
        if 'on_demand_per_gpu_hr' not in out:
            raise SourceError(f"Azure {feed['sku']} in {feed['region']} not found")
        return out


class Google:
    name = 'Google Cloud'
    url = 'https://cloud.google.com/products/compute/pricing/accelerator-optimized'

    def __init__(self):
        self.raw = get(self.url)

    def lookup(self, feed, offer):
        rows = re.finditer(r'<tr[^>]*>((?:(?!</tr>)[\s\S])*?' + re.escape(feed['machine']) + r'[\s\S]*?)</tr>', self.raw)
        row = next(rows, None)
        if not row:
            raise SourceError(f"Google {feed['machine']} not found")
        cells = [re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', c))).strip()
                 for c in re.findall(r'<td[^>]*>([\s\S]*?)</td>', row.group(1))]
        # Columns: machine | GPU | components | price | DWS flex | DWS calendar | spot | CUD 1y | CUD 3y
        if len(cells) < 9:
            raise SourceError(f"Google {feed['machine']} row has {len(cells)} columns (layout changed?)")

        def val(c):
            mm = re.search(r'\$([\d.,]+)', c)
            return money(mm.group(1)) if mm else None
        n = offer['gpus_per_instance']
        od = val(cells[4] if feed.get('on_demand') == 'flex' else cells[3])
        out = {}
        if od:
            out['on_demand_per_gpu_hr'] = r4(od / n)
        for yrs, idx in ((1, 7), (3, 8)):
            v = val(cells[idx])
            if v:
                out[f'reserved_terms_per_gpu_hr.{yrs}'] = r4(v / n)
        return out


SOURCES = {
    'openrouter': OpenRouter, 'openrouter-endpoint': OpenRouter, 'fireworks': Fireworks, 'deepseek': DeepSeek,
    'lambda': Lambda, 'coreweave': CoreWeave, 'nebius': Nebius, 'together-gpu': TogetherGPU,
    'aws-capacity-blocks': AWSCapacityBlocks, 'azure': Azure, 'google': Google,
    'azure-foundry': AzureFoundry, 'vertex': Vertex,
}


# ------------------------------------------------------------------ main
def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    force, dry = '--force' in sys.argv, '--dry-run' in sys.argv
    today = datetime.date.today().isoformat()
    now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%MZ')

    models = json.load(open(os.path.join(DATA, 'models.json'), encoding='utf-8'))
    gpus = json.load(open(os.path.join(DATA, 'gpus.json'), encoding='utf-8'))

    loaded, status = {}, {}
    changed, review, problems, manual = [], [], [], []

    def source(name):
        cls = SOURCES[name]
        if cls not in loaded:
            try:
                loaded[cls] = cls()
                status.setdefault(cls.name, {'ok': True, 'url': cls.url, 'rows': 0, 'changed': 0, 'error': ''})
            except Exception as e:  # noqa: BLE001
                loaded[cls] = e
                status[cls.name] = {'ok': False, 'url': cls.url, 'rows': 0, 'changed': 0, 'error': str(e)[:300]}
        return loaded[cls], cls.name

    def apply(row, values, src_text, label, sname, extra_status=None):
        for key, val in values.items():
            if val is None:
                continue
            path = key.split('.')
            parent = row
            for p in path[:-1]:
                parent = parent.setdefault(p, {})
            cur = parent.get(path[-1])
            old = cur.get('value') if isinstance(cur, dict) else None
            if old == val:
                continue
            name = f'{label} / {NICE.get(key, key)}'
            if isinstance(old, (int, float)) and old > 0 and abs(val - old) / old > MAX_CHANGE and not force:
                review.append(f'{name}: {old} → {val} (not applied; over {int(MAX_CHANGE * 100)}% change)')
                continue
            parent[path[-1]] = {'value': val, 'source': src_text, 'as_of': today, 'status': extra_status or 'estimate'}
            changed.append(f'{name}: {old if old is not None else "unset"} → {val}')
            status[sname]['changed'] += 1

    # ---- API prices
    for m in models['models']:
        for row in m.get('api_prices', []):
            label = f"{m['name']} / {row['provider']}"
            fd = row.get('feed')
            if not fd:
                manual.append(f'API: {label}')
                continue
            src, sname = source(fd['source'])
            if isinstance(src, Exception):
                continue
            status[sname]['rows'] += 1
            try:
                if fd['source'] == 'openrouter':
                    vals = src.model(fd['id'], mirror=fd.get('mode') == 'mirror')
                    txt = (f"{row['provider']} list price, checked via OpenRouter ({fd['id']})" if fd.get('mode') == 'mirror'
                           else f"openrouter.ai/api/v1/models ({fd['id']})")
                elif fd['source'] == 'openrouter-endpoint':
                    vals = src.endpoint(fd['id'], fd['provider'])
                    txt = f"{fd['provider']} price listed on OpenRouter ({fd['id']} endpoints)"
                elif fd['source'] == 'fireworks':
                    vals = src.lookup(fd)
                    txt = f"docs.fireworks.ai/serverless/pricing ({fd.get('model') or 'size tier: ' + fd['tier']})"
                elif fd['source'] == 'azure-foundry':
                    vals = src.lookup(fd)
                    txt = f"Azure Retail Prices API, Foundry Models ({fd['input']} / {fd['output']}, {fd.get('region', 'eastus2')})"
                elif fd['source'] == 'vertex':
                    vals = src.lookup(fd)
                    txt = f"cloud.google.com/vertex-ai/generative-ai/pricing ({fd['model']})"
                else:
                    vals = src.lookup(fd)
                    txt = 'api-docs.deepseek.com/quick_start/pricing (peak rate; off-peak is 50% lower)'
                apply(row, vals, txt, label, sname, fd.get('status'))
            except SourceError as e:
                problems.append(f'{label}: {e}')

    # ---- GPU rental prices
    for g in gpus['gpus']:
        for offer in g.get('cloud', []):
            label = f"{g['name']} / {offer['provider']} {offer['instance']}"
            fd = offer.get('feed')
            if not fd:
                manual.append(f'GPU rental: {label}')
                continue
            src, sname = source(fd['source'])
            if isinstance(src, Exception):
                continue
            status[sname]['rows'] += 1
            try:
                vals = src.lookup(fd, offer)
                has_rsv = isinstance(offer.get('reserved_per_gpu_hr'), dict) and offer['reserved_per_gpu_hr'].get('value') is not None
                if has_rsv and 'reserved_per_gpu_hr' not in vals:
                    manual.append(f'GPU rental: {label} (reserved rate only)')
                where = {k: v for k, v in fd.items() if k != 'source'}
                apply(offer, vals, f"{src.url} ({', '.join(f'{k}: {v}' for k, v in where.items())}) ÷ GPUs where priced per instance", label, sname)
            except SourceError as e:
                problems.append(f'{label}: {e}')

    failed = [f'{k}: {v["error"]}' for k, v in status.items() if not v['ok']]
    report = {
        'checked_at': now, 'date': today,
        'values_changed': len(changed), 'changed': changed,
        'needs_review': review, 'problems': problems, 'sources_failed': failed,
        'manual_rows': manual,
        'sources': status,
    }

    lines = [f'## Price update — {now}', '',
             f'{sum(s["rows"] for s in status.values())} price rows checked across {len(status)} sources; '
             f'{len(changed)} value(s) changed.', '']
    for title, items in (('Changed', changed), ('Needs review (not applied)', review),
                         ('Sources that failed (prices left unchanged)', failed), ('Rows that could not be read', problems),
                         ('Manual rows (no automatic source)', manual)):
        if items:
            lines += [f'### {title}'] + [f'- {x}' for x in items] + ['']
    summary = '\n'.join(lines)
    print(summary)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as f:
            f.write(summary + '\n')
    for x in review:
        print(f'::warning title=Price change needs review::{x}')
    for x in failed + problems:
        print(f'::warning title=Price source problem::{x}')

    if dry:
        return

    def write(name, obj):
        with open(os.path.join(DATA, name), 'w', encoding='utf-8', newline='\n') as f:
            json.dump(obj, f, indent=2, ensure_ascii=False)
            f.write('\n')
    if changed:
        write('models.json', models)
        write('gpus.json', gpus)
    write('price-status.json', report)


if __name__ == '__main__':
    main()
