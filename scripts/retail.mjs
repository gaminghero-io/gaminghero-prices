// Gaming Hero price collector: Retail WoW auction house prices from the Blizzard API.
// Tracks only the items used in Gaming Hero's Retail guides (data/retail-items.json).
// Commodities (materials, reagents) come from the region-wide commodity house.
// Everything else (gear, pets, mounts, recipes) is read from every connected realm in the region,
// and the region price is the median of each realm's cheapest listing.
// Runs every few hours on GitHub Actions. Needs BLIZZ_ID and BLIZZ_SECRET (repository secrets).
import fs from 'node:fs/promises';

const REGIONS = (process.env.REGIONS || 'eu,us').split(',');
const ID = process.env.BLIZZ_ID, SECRET = process.env.BLIZZ_SECRET;
const MAX_LOOKUPS = 800;     // item names to look up per run
const REALM_CONCURRENCY = 6;
const PET_CAGE = 82800;
if (!ID || !SECRET) { console.error('Missing BLIZZ_ID / BLIZZ_SECRET'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = async (f, d) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return d; } };
const norm = s => String(s || '').toLowerCase().replace(/[‘’′`]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

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
async function api(region, path, ns, extra = '', tries = 4) {
  const url = `https://${region}.api.blizzard.com${path}${path.includes('?') ? '&' : '?'}namespace=${ns}&locale=en_GB${extra}`;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + TOKEN } });
      if (r.status === 404) return null;
      if (r.ok) return await r.json();
      if (r.status === 429 || r.status >= 500) { await sleep(2000 * (i + 1)); continue; }
      throw new Error(`${r.status} on ${path} (${ns})`);
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(2000 * (i + 1));
    }
  }
  return undefined; // still failing after retries
}
const nameOf = n => (typeof n === 'string' ? n : (n?.en_GB || n?.en_US || ''));

// ---------- name -> id resolution (cached in data/retail-ids.json) ----------
// Each entry: { v: 2, ids: [item ids], pet: species id or null, at: time looked up }.
// Names that were not found are retried after a few days (the API search sometimes misses).
const TIER = { copper: 0, silver: 1, gold: 2 };
const RETRY_MISSING_MS = 3 * 864e5;
async function searchItem(base) {
  const want = norm(base);
  let hits = [];
  for (let page = 1; page <= 6; page++) {
    const j = await api('eu', '/data/wow/search/item', 'static-eu', `&name.en_US=${encodeURIComponent(base)}&orderby=id&_pageSize=1000&_page=${page}`);
    if (j === undefined) return undefined; // API trouble: try again next run
    if (!j || !j.results) break;
    for (const r of j.results) { const d = r.data; if (norm(nameOf(d.name)) === want) hits.push(d.id); }
    if (page >= (j.pageCount || 1)) break;
  }
  return hits.sort((a, b) => a - b);
}
async function resolveNames(list, ids) {
  let pets = null, done = 0;
  const pj = await api('eu', '/data/wow/pet/index', 'static-eu');
  pets = {};
  for (const p of (pj && pj.pets) || []) pets[norm(nameOf(p.name))] = p.id;
  for (const raw of list) {
    const key = norm(raw), cur = ids[key];
    const fresh = cur && cur.v === 2 && (cur.ids.length || cur.pet || Date.now() - (cur.at || 0) < RETRY_MISSING_MS);
    if (fresh || done >= MAX_LOOKUPS) continue;
    done++;
    let base = raw, tier = null;
    const m = raw.match(/^(.*)\((copper|silver|gold)\)\s*$/i);
    if (m) { base = m[1].trim(); tier = TIER[m[2].toLowerCase()]; }
    let hits = await searchItem(base);
    if (hits === undefined) { done--; continue; }
    if (tier !== null && hits.length) hits = [hits[Math.min(tier, hits.length - 1)]];
    ids[key] = { v: 2, ids: hits, pet: pets[norm(base)] || null, at: Date.now() };
    await sleep(30);
  }
  const miss = list.filter(n => { const r = ids[norm(n)]; return r && !r.ids.length && !r.pet; });
  console.log('resolved', done, 'names;', miss.length, 'not found:', miss.join(' | '));
}

// ---------- price collection ----------
function median(a) { a.sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2); }
// average of the cheapest 15% of the listed quantity (ignores single cheap or silly listings)
function market(rows) {
  rows.sort((x, y) => x[0] - y[0]);
  const qty = rows.reduce((s, x) => s + x[1], 0), need = Math.max(1, qty * 0.15);
  let sv = 0, sq = 0;
  for (const [p, q] of rows) { if (sq >= need) break; const t = Math.min(q, need - sq); sv += p * t; sq += t; }
  return { p: Math.round(sv / sq), qty };
}

async function collectRegion(region, list, ids) {
  const ns = `dynamic-${region}`;
  const itemIds = new Set(), petIds = new Set();
  for (const raw of list) { const r = ids[norm(raw)]; if (!r) continue; for (const id of r.ids || []) itemIds.add(id); if (r.pet) petIds.add(r.pet); }

  // 1) commodities, region wide
  const comm = {};
  const cj = await api(region, '/data/wow/auctions/commodities', ns);
  for (const a of (cj && cj.auctions) || []) {
    const id = a.item && a.item.id;
    if (!itemIds.has(id) || !a.unit_price) continue;
    (comm[id] ||= []).push([a.unit_price, a.quantity || 1]);
  }
  console.log(region, 'commodities tracked:', Object.keys(comm).length);

  // 2) every connected realm: cheapest listing of each tracked item / pet
  const idx = await api(region, '/data/wow/connected-realm/index', ns);
  const realms = ((idx && idx.connected_realms) || []).map(x => new URL(x.href).pathname.split('/').pop());
  console.log(region, 'connected realms:', realms.length);
  const realmMin = {}; // key -> [min per realm]
  let i = 0, ok = 0;
  async function worker() {
    while (i < realms.length) {
      const rid = realms[i++];
      let j;
      try { j = await api(region, `/data/wow/connected-realm/${rid}/auctions`, ns); } catch (e) { console.log('  realm', rid, 'failed:', e.message); continue; }
      if (!j || !j.auctions) continue;
      ok++;
      const best = {};
      for (const a of j.auctions) {
        const it = a.item; if (!it) continue;
        const price = a.buyout ? Math.round(a.buyout / (a.quantity || 1)) : a.unit_price; if (!price) continue;
        let key = null;
        if (it.id === PET_CAGE && it.pet_species_id) { if (petIds.has(it.pet_species_id)) key = 'p' + it.pet_species_id; }
        else if (itemIds.has(it.id) && !comm[it.id]) key = 'i' + it.id;
        if (key && (!best[key] || price < best[key])) best[key] = price;
      }
      for (const [k, v] of Object.entries(best)) (realmMin[k] ||= []).push(v);
    }
  }
  await Promise.all(Array.from({ length: REALM_CONCURRENCY }, worker));
  console.log(region, 'realms read:', ok, '/', realms.length);

  // 3) one price per guide item name
  const out = {};
  for (const raw of list) {
    const r = ids[norm(raw)]; if (!r) continue;
    let best = null;
    const cands = (r.ids || []).map(id => ['i', id]);
    if (r.pet) cands.push(['p', r.pet]);
    for (const [k, id] of cands) {
      if (k === 'i' && comm[id]) { const m = market(comm[id]); const c = { p: m.p, n: m.qty, s: 'c', id }; if (!best || best.s !== 'c' || c.n > best.n) best = c; continue; }
      const arr = realmMin[k + id];
      if (arr && arr.length && (!best || best.s !== 'c')) { const c = { p: median(arr.slice()), n: arr.length, s: k === 'p' ? 'pet' : 'r', id }; if (!best || c.n > best.n) best = c; }
    }
    if (best) out[norm(raw)] = best;
  }
  return { realms: ok, items: out };
}

TOKEN = await token();
const list = await readJson('data/retail-items.json', []);
const ids = await readJson('data/retail-ids.json', {});
await resolveNames(list, ids);
await fs.writeFile('data/retail-ids.json', JSON.stringify(ids));

for (const region of REGIONS) {
  try {
    const r = await collectRegion(region, list, ids);
    if (!Object.keys(r.items).length) throw new Error('no prices collected');
    await fs.writeFile(`data/retail-${region}.json`, JSON.stringify({ game: 'retail', region, updated: new Date().toISOString(), realms: r.realms, items: r.items }));
    console.log(region, 'priced items:', Object.keys(r.items).length);
  } catch (e) {
    console.error(region, 'FAILED:', e.message); // keep the previous file so the site shows the last good prices
  }
}
