import fs from 'node:fs';

const OUT = process.env.QUOTES_OUT || 'quotes.json';
const TWSE = 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL';
const TPEX = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 30000);
      const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': 'budget-app-quote-updater' } });
      clearTimeout(timer);
      console.log(`GET ${url} -> HTTP ${r.status} ${r.headers.get('content-type') || ''}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      last = e;
      console.error(`attempt ${i}/${tries} failed for ${url}: ${e.message}`);
      if (i < tries) await sleep(2000 * i);
    }
  }
  throw last;
}

function rocToIso(d) {
  d = String(d ?? '').trim();
  if (/^\d{7}$/.test(d)) return `${parseInt(d.slice(0, 3), 10) + 1911}-${d.slice(3, 5)}-${d.slice(5, 7)}`;
  if (/^\d{8}$/.test(d)) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  return '';
}
function parsePrice(v) {
  const s = String(v ?? '').replace(/,/g, '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
  const n = parseFloat(s);
  return n > 0 ? n : NaN;
}

function parseRows(rows, codeKey, priceKey, nameKey) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('empty or non-array response');
  if (!rows.some((r) => r && codeKey in r && priceKey in r)) throw new Error(`fields ${codeKey}/${priceKey} not found; keys: ${Object.keys(rows[0] || {}).join(',')}`);
  const quotes = {};
  let max = '';
  for (const r of rows) {
    const code = String(r?.[codeKey] ?? '').trim();
    const p = parsePrice(r?.[priceKey]);
    const d = rocToIso(r?.Date);
    if (!code || isNaN(p) || !d) continue;
    quotes[code] = { p, d, n: r?.[nameKey] || '' };
    if (d > max) max = d;
  }
  return { quotes, max };
}

const twse = parseRows(await getJson(TWSE), 'Code', 'ClosingPrice', 'Name');
const nTwse = Object.keys(twse.quotes).length;
if (nTwse < 500) throw new Error(`TWSE returned only ${nTwse} priced rows - refusing to publish a partial file`);
console.log(`TWSE: ${nTwse} priced rows, data date ${twse.max}`);

const quotes = { ...twse.quotes };
let tpexInfo = 'skipped';
try {
  const tp = parseRows(await getJson(TPEX), 'SecuritiesCompanyCode', 'Close', 'CompanyName');
  let added = 0;
  for (const [c, q] of Object.entries(tp.quotes)) if (!(c in quotes)) { quotes[c] = q; added++; }
  tpexInfo = `${added} OTC rows added, data date ${tp.max}`;
} catch (e) {
  tpexInfo = `failed (${e.message})`;
}
console.log(`TPEx: ${tpexInfo}`);

let old = null;
try { old = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {}
if (old && old.dataDate && twse.max < old.dataDate) {
  console.log(`New data date ${twse.max} is older than existing ${old.dataDate}; keeping existing file.`);
  process.exit(0);
}
if (old && old.dataDate === twse.max && JSON.stringify(old.quotes) === JSON.stringify(quotes)) {
  console.log('No change in quotes; not rewriting file.');
  process.exit(0);
}
fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), dataDate: twse.max, sources: { twse: TWSE, tpex: tpexInfo }, quotes }));
console.log(`Wrote ${OUT} (${Object.keys(quotes).length} codes, data date ${twse.max})`);
