// Gaming Hero price collector: WoW Forever auction house prices from the Blizzard API.
// Runs hourly on GitHub Actions. Needs BLIZZ_ID and BLIZZ_SECRET (repository secrets).
import fs from 'node:fs/promises';

const REGIONS = (process.env.REGIONS || 'eu,us').split(',');
const ID = process.env.BLIZZ_ID, SECRET = process.env.BLIZZ_SECRET;
const MAX_NAME_LOOKUPS = 1500;          // new item names to resolve per run (per region), busiest items first
const MAX_SELL_LOOKUPS = 1500;          // vendor sell prices to backfill per run (per region)
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

async function collectRegion(region, names, sells = {}) {
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
  const hmap = ((await readJson('data/house-map.json', {}))[region]) || {};

  const per = {}; // rulesetId -> itemId -> {a:[], h:[], n:[]}
  const seen = {}; // itemId -> listing count (for name lookup priority)
  const rsNames = Object.fromEntries(rulesets.map(r => [String(r.id), typeof r.name === 'string' ? r.name : (r.name?.en_GB || r.name?.en_US || String(r.id))]));
  rsNames.all = 'All rulesets';
  let rows = 0;
  for (const h of houses) {
    const hid = h.id ?? (h.key?.href && new URL(h.key.href).pathname.split('/').pop());
    const hname = typeof h.name === 'string' ? h.name : (h.name?.en_GB || h.name?.en_US || '');
    const t = houseType(hname);
    const detail = await api(region, `/data/wow/ruleset/${rs}/auctions/${hid}`, ns);
    if (!detail) continue;
    const rr = detail.ruleset;
    const rid = String(hmap[hid] ?? (rr == null ? 'x' + hid : (typeof rr === 'object' ? (rr.id ?? (rr.key?.href ? new URL(rr.key.href).pathname.split('/').pop() : 'x' + hid)) : rr)));
    const P = (per[rid] ||= {});
    const add = (id, row) => { ((P[id] ||= { a: [], h: [], n: [] })[t]).push(row); seen[id] = (seen[id] || 0) + 1; };
    let items = await listOrLink(region, detail.auctions, ns);
    let comm = Array.isArray(detail.commodities) ? detail.commodities : null;
    if (!comm) { const c = await api(region, `/data/wow/ruleset/${rs}/auctions/${hid}/commodities`, ns); comm = (c && c.auctions) || []; }
    for (const a of items) {
      if (!a.buyout || !a.item) continue;
      const q = a.quantity || 1;
      add(a.item.id, [Math.round(a.buyout / q), q]);
    }
    for (const a of comm) {
      if (!a.unit_price || !a.item) continue;
      add(a.item.id, [a.unit_price, a.quantity || 1]);
    }
    rows += items.length + comm.length;
    console.log(`  house ${hid} ${hname} (ruleset ${rid} ${rsNames[rid] || ''}): ${items.length} auctions, ${comm.length} commodities`);
    await sleep(250);
  }

  // Resolve names for new items
  const missing = Object.keys(seen).filter(id => !(id in names)).sort((x, y) => seen[y] - seen[x]).slice(0, MAX_NAME_LOOKUPS);
  for (const id of missing) {
    let j = await api(region, `/data/wow/item/${id}`, `static-forever-${region}`);
    if (!j) j = await api(region, `/data/wow/item/${id}`, `static-classic1x-${region}`);
    const nm = j && (typeof j.name === 'string' ? j.name : (j.name?.en_GB || j.name?.en_US));
    names[id] = nm || '';
    if (j && j.sell_price != null) sells[id] = j.sell_price;
    await sleep(15);
  }
  // Backfill vendor sell prices for items we already know (used by the AH Deal Finder)
  const needSell = Object.keys(names).filter(id => !(id in sells)).slice(0, MAX_SELL_LOOKUPS);
  for (const id of needSell) {
    let j = await api(region, `/data/wow/item/${id}`, `static-forever-${region}`);
    if (!j) j = await api(region, `/data/wow/item/${id}`, `static-classic1x-${region}`);
    sells[id] = j && j.sell_price != null ? j.sell_price : 0;
    await sleep(15);
  }

  const out = {};
  for (const [rid, P] of Object.entries(per)) {
    const o2 = (out[rid] = {});
    for (const [id, f] of Object.entries(P)) {
      const o = {};
      for (const t of ['a', 'h', 'n']) if (f[t].length) o[t] = stats(f[t]);
      o2[id] = o;
    }
  }
  // 'all' = every live ruleset combined: each ruleset's market price weighted by how much it has listed.
  // (Hardcore 'hc' houses are empty and left out.)
  const all = {};
  for (const [rid, its] of Object.entries(out)) {
    if (rid === 'hc') continue;
    for (const [id, o] of Object.entries(its)) for (const [t, st] of Object.entries(o)) {
      const x = ((all[id] ||= {})[t] ||= { min: Infinity, w: 0, wm: 0, qty: 0, n: 0 });
      x.min = Math.min(x.min, st.min); x.wm += st.mkt * st.qty; x.w += st.med * st.qty; x.qty += st.qty; x.n += st.n;
    }
  }
  for (const o of Object.values(all)) for (const [t, x] of Object.entries(o)) o[t] = { min: x.min, mkt: Math.round(x.wm / x.qty), med: Math.round(x.w / x.qty), qty: x.qty, n: x.n };
  out.all = all;
  return { rows, houses: houses.length, rulesets: out, rsNames };
}

async function main() {
  TOKEN = await token();
  const names = await readJson('data/item-names.json', {});
  const sells = await readJson('data/item-sell.json', {});
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  for (const region of REGIONS) {
    try {
      const r = await collectRegion(region, names, sells);
      const index = [];
      for (const [rid, its] of Object.entries(r.rulesets)) {
        if (!Object.keys(its).length) continue;
        const items = {};
        for (const [id, o] of Object.entries(its)) items[id] = { name: names[id] || '', ...o };
        const base = `data/forever-${region}-r${rid}`;
        await fs.writeFile(`${base}.json`, JSON.stringify({ updated: now.toISOString(), region, game: 'forever', ruleset: rid, rulesetName: r.rsNames[rid] || '', items }));
        index.push({ id: rid, name: r.rsNames[rid] || '', items: Object.keys(items).length });
        // Daily history: one market price per item per faction, kept for HISTORY_DAYS
        const hist = await readJson(`${base}-history.json`, { days: [], items: {} });
        if (hist.days[hist.days.length - 1] !== day) {
          hist.days.push(day);
          for (const [id, o] of Object.entries(its)) {
            const row = (hist.items[id] ||= []);
            while (row.length < hist.days.length - 1) row.push(null);
            const best = o.a || o.h || o.n;
            row.push([o.a?.mkt ?? null, o.h?.mkt ?? null, o.n?.mkt ?? null, best?.qty ?? 0]);
          }
          for (const row of Object.values(hist.items)) while (row.length < hist.days.length) row.push(null);
          while (hist.days.length > HISTORY_DAYS) { hist.days.shift(); for (const row of Object.values(hist.items)) row.shift(); }
          await fs.writeFile(`${base}-history.json`, JSON.stringify(hist));
        }
        console.log(`${region} ruleset ${rid} ${r.rsNames[rid] || ''}: ${Object.keys(items).length} items`);
      }
      await fs.writeFile(`data/forever-${region}-index.json`, JSON.stringify({ updated: now.toISOString(), rulesets: index }));
      console.log(`${region}: ${r.rows} listings`);
    } catch (e) {
      console.error(`${region} failed:`, e.message);
      process.exitCode = 1;
    }
  }
  await fs.writeFile('data/item-names.json', JSON.stringify(names));
  await fs.writeFile('data/item-sell.json', JSON.stringify(sells));
}

main().catch(e => { console.error(e); process.exit(1); });
