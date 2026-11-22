// Gaming Hero price collector: WoW Forever auction house prices from the Blizzard API.
// Runs hourly on GitHub Actions. Needs BLIZZ_ID and BLIZZ_SECRET (repository secrets).
import fs from 'node:fs/promises';

const REGIONS = (process.env.REGIONS || 'eu,us').split(',');
const ID = process.env.BLIZZ_ID, SECRET = process.env.BLIZZ_SECRET;
const MAX_NAME_LOOKUPS = 600;           // new item names to resolve per run (per region)
const HISTORY_DAYS = 45;
if (!ID || !SECRET) { console.error('Missing BLIZZ_ID / BLIZZ_SECRET'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = async (f, d) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return d; } };

async function token() {
  const r = await fetch('https://oauth.battle.net/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(ID + ':' + SECRET).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error('Token request failed: ' + r.status + ' ' + await r.text());
  return (await r.json()).access_token;
}

let TOKEN;
async function api(region, path, ns, tries = 3) {
  const url = `https://${region}.api.blizzard.com${path}${path.includes('?') ? '&' : '?'}namespace=${ns}&locale=en_GB`;
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (r.status === 404) return null;
    if (r.ok) return r.json();
    if (r.status === 429 || r.status >= 500) { await sleep(1500 * (i + 1)); continue; }
    throw new Error(`${r.status} on ${path} (${ns})`);
  }
  throw new Error('Gave up on ' + path);
}

// Follow either an inline array or a {href} link
async function listOrLink(region, v, ns) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (v.href) {
    const u = new URL(v.href);
    const j = await api(region, u.pathname, ns);
    return (j && (j.auctions || j.commodities)) || [];
  }
  return [];
}

function houseType(name = '') {
  const n = name.toLowerCase();
  if (n.includes('alliance')) return 'a';
  if (n.includes('horde')) return 'h';
  return 'n'; // Blackwater / neutral
}

// Weighted percentile of unit prices (quantity weighted)
function stats(list) {
  list.sort((x, y) => x[0] - y[0]);
  const qty = list.reduce((s, x) => s + x[1], 0);
  const at = p => { let t = qty * p, c = 0; for (const [pr, q] of list) { c += q; if (c >= t) return pr; } return list[list.length - 1][0]; };
  // "market": average of the cheapest 15% of the volume, ignoring silly outliers above 1.5x the 15th percentile
  const cut = at(0.15), lim = Math.round(cut * 1.5);
  let sv = 0, sq = 0, need = Math.max(1, qty * 0.15);
  for (const [pr, q] of list) { if (pr > lim || sq >= need) break; const take = Math.min(q, need - sq); sv += pr * take; sq += take; }
  return { min: list[0][0], mkt: Math.round(sq ? sv / sq : list[0][0]), med: at(0.5), qty, n: list.length };
}

async function collectRegion(region, names) {
  const ns = `dynamic-forever-${region}`;
  const idx = await api(region, '/data/wow/ruleset/index', ns);
  const rulesets = (idx && idx.rulesets) || [];
  console.log(region, 'rulesets:', rulesets.map(r => r.id + ':' + (r.name?.en_GB || r.name)).join(', '));
  // Ruleset currently does not filter auctions (same houses under every ruleset), so read one.
  const rs = (rulesets.find(r => r.id === 2) || rulesets[0])?.id;
  if (!rs) throw new Error('No rulesets for ' + region);
  const hidx = await api(region, `/data/wow/ruleset/${rs}/auctions/`, ns);
  const houses = (hidx && hidx.auctions) || [];
  console.log(region, 'houses:', houses.length);

  const per = {}; // itemId -> {a:[], h:[], n:[]}
  let rows = 0;
  for (const h of houses) {
    const hid = h.id ?? (h.key?.href && new URL(h.key.href).pathname.split('/').pop());
    const hname = typeof h.name === 'string' ? h.name : (h.name?.en_GB || h.name?.en_US || '');
    const t = houseType(hname);
    const detail = await api(region, `/data/wow/ruleset/${rs}/auctions/${hid}`, ns);
    if (!detail) continue;
    let items = await listOrLink(region, detail.auctions, ns);
    let comm = Array.isArray(detail.commodities) ? detail.commodities : null;
    if (!comm) { const c = await api(region, `/data/wow/ruleset/${rs}/auctions/${hid}/commodities`, ns); comm = (c && c.auctions) || []; }
    for (const a of items) {
      if (!a.buyout || !a.item) continue;
      const q = a.quantity || 1;
      ((per[a.item.id] ||= { a: [], h: [], n: [] })[t]).push([Math.round(a.buyout / q), q]);
    }
    for (const a of comm) {
      if (!a.unit_price || !a.item) continue;
      ((per[a.item.id] ||= { a: [], h: [], n: [] })[t]).push([a.unit_price, a.quantity || 1]);
    }
    rows += items.length + comm.length;
    console.log(`  house ${hid} ${hname}: ${items.length} auctions, ${comm.length} commodities`);
    await sleep(250);
  }

  // Resolve names for new items
  const missing = Object.keys(per).filter(id => !(id in names)).slice(0, MAX_NAME_LOOKUPS);
  for (const id of missing) {
    let j = await api(region, `/data/wow/item/${id}`, `static-forever-${region}`);
    if (!j) j = await api(region, `/data/wow/item/${id}`, `static-classic1x-${region}`);
    if (!j) j = await api(region, `/data/wow/item/${id}`, `static-${region}`);
    const nm = j && (typeof j.name === 'string' ? j.name : (j.name?.en_GB || j.name?.en_US));
    names[id] = nm || '';
    await sleep(30);
  }

  const out = {};
  for (const [id, f] of Object.entries(per)) {
    const o = {};
    for (const t of ['a', 'h', 'n']) if (f[t].length) o[t] = stats(f[t]);
    out[id] = o;
  }
  return { rows, houses: houses.length, items: out };
}

async function main() {
  TOKEN = await token();
  const names = await readJson('data/item-names.json', {});
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  for (const region of REGIONS) {
    try {
      const r = await collectRegion(region, names);
      const items = {};
      for (const [id, o] of Object.entries(r.items)) items[id] = { name: names[id] || '', ...o };
      await fs.writeFile(`data/forever-${region}.json`, JSON.stringify({ updated: now.toISOString(), region, game: 'forever', houses: r.houses, listings: r.rows, items }));
      // Daily history: one market price per item per faction, kept for HISTORY_DAYS
      const hist = await readJson(`data/forever-${region}-history.json`, { days: [], items: {} });
      if (hist.days[hist.days.length - 1] !== day) {
        hist.days.push(day);
        for (const [id, o] of Object.entries(r.items)) {
          const row = (hist.items[id] ||= []);
          while (row.length < hist.days.length - 1) row.push(null);
          const best = o.a || o.h || o.n;
          row.push([o.a?.mkt ?? null, o.h?.mkt ?? null, o.n?.mkt ?? null, best?.qty ?? 0]);
        }
        for (const row of Object.values(hist.items)) while (row.length < hist.days.length) row.push(null);
        while (hist.days.length > HISTORY_DAYS) { hist.days.shift(); for (const row of Object.values(hist.items)) row.shift(); }
        await fs.writeFile(`data/forever-${region}-history.json`, JSON.stringify(hist));
      }
      console.log(`${region}: ${Object.keys(items).length} items from ${r.rows} listings`);
    } catch (e) {
      console.error(`${region} failed:`, e.message);
      process.exitCode = 1;
    }
  }
  await fs.writeFile('data/item-names.json', JSON.stringify(names));
}

main().catch(e => { console.error(e); process.exit(1); });
