// Finds companies for the pool, works out which hiring platform each one uses, and writes pool.json.
// Run weekly by the GitHub Action, or by hand. Never touches jobs.json.
//
// Each company ends up as one of:
//   matched    a Greenhouse, Ashby or Lever board that clearly belongs to the company (read by the daily refresh)
//   unsure     a board that might be the company's, waiting for your yes or no
//   notfound   no board found, kept on a list for you to investigate or dismiss
//   rejected / dismissed   your decisions, never retried
import { readFile, writeFile } from 'node:fs/promises';
import { norm, slugVariants, mentions } from './pool-lib.mjs';
import { isTooOld } from './filters.mjs';

const ROOT = new URL('../', import.meta.url);
const UA = 'job-watch personal job tracker (weekly company discovery, low volume)';
const RETRY_NOTFOUND_DAYS = 28;
const DAY = 864e5;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = new Date().toISOString();

async function readJson(name, fallback) {
  try { return JSON.parse(await readFile(new URL(name, ROOT), 'utf8')); } catch { return fallback; }
}
async function readLines(name) {
  try {
    return (await readFile(new URL(name, ROOT), 'utf8')).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  } catch { return []; }
}

const rules = await readJson('pool-rules.json', {});
const MAX_RESOLVE = parseInt(process.env.MAX_RESOLVE_PER_RUN || rules.maxResolvePerRun || 80, 10);

// One polite request. Returns { res } on any answer, { status: 404 } for a missing page, { transient: true } for rate limits and outages.
async function http(url, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: AbortSignal.timeout(25000) });
      if (res.status === 404) return { status: 404 };
      if (res.status === 429 || res.status >= 500) {
        if (i < tries - 1) { await wait(2000 * (i + 1)); continue; }
        return { status: res.status, transient: true };
      }
      return { status: res.status, res };
    } catch {
      if (i < tries - 1) { await wait(1500); continue; }
      return { transient: true };
    }
  }
  return { transient: true };
}

// ---------- Collecting names ----------

async function museNames() {
  const out = [];
  const cats = rules.museCategories || ['Data and Analytics'];
  const locs = rules.museLocations || ['New York, NY'];
  const pages = rules.musePagesPerQuery || 5;
  for (const cat of cats) {
    for (const loc of locs) {
      for (let p = 1; p <= pages; p++) {
        const url = `https://www.themuse.com/api/public/jobs?category=${encodeURIComponent(cat)}&location=${encodeURIComponent(loc)}&page=${p}`;
        const r = await http(url);
        if (!r.res?.ok) { console.log(`The Muse: "${cat}" in "${loc}" page ${p}: no usable answer (${r.status ?? 'error'}), moving on`); break; }
        let j;
        try { j = await r.res.json(); } catch { break; }
        for (const item of j.results || []) if (item.company?.name && !isTooOld(item.publication_date)) out.push(item.company.name);
        if (p >= (j.page_count || 1)) break;
        await wait(400);
      }
    }
  }
  return out;
}

async function robotsAllows(origin, path) {
  const r = await http(origin + '/robots.txt');
  if (r.status === 404) return true;
  if (!r.res?.ok) return false; // cannot check, so do not scrape
  const text = await r.res.text();
  let applies = false;
  const disallow = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase(), value = m[2].trim();
    if (field === 'user-agent') applies = value === '*';
    else if (applies && field === 'disallow' && value) disallow.push(value);
  }
  return !disallow.some((d) => path.startsWith(d));
}

// Company names from the Tech Jobs for Good company list (every company there has open tech roles).
async function tjfgNames() {
  const origin = 'https://techjobsforgood.com';
  if (!(await robotsAllows(origin, '/'))) { console.log('Tech Jobs for Good: robots.txt does not allow this, skipped'); return []; }
  const bySlug = new Map();
  const maxPages = rules.tjfgPages || 6;
  for (let p = 1; p <= maxPages; p++) {
    const r = await http(p === 1 ? `${origin}/companies/` : `${origin}/companies/?page=${p}`);
    if (!r.res?.ok) { console.log(`Tech Jobs for Good: page ${p} gave no usable answer (${r.status ?? 'error'}), stopping`); break; }
    const html = await r.res.text();
    if (p === 1) {
      // Shows what the page looks like, so the name reader can be matched to it if it finds nothing.
      const hrefs = [...html.matchAll(/<a\b[^>]*href="([^"#]+)"/gi)].map((m) => m[1].replace(/^https?:\/\/[^/]+/, '').replace(/[0-9a-f]{8,}|\d{3,}/gi, 'N').split('?')[0]);
      const counts = new Map();
      for (const h of hrefs) { const k = h.split('/').slice(0, 3).join('/'); counts.set(k, (counts.get(k) || 0) + 1); }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${k} x${n}`).join('  ');
      const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
      console.log(`Tech Jobs for Good page 1: status ${r.status ?? r.res.status}, ended at ${r.res.url}, title "${String(title || 'none').replace(/\s+/g, ' ').trim().slice(0, 80)}"`);
      console.log(`Tech Jobs for Good page 1 (${origin}/companies/): ${html.length} chars, ${hrefs.length} links. Link patterns: ${top || 'none'}${/__NEXT_DATA__/.test(html) ? '. Page data is loaded by script (__NEXT_DATA__)' : ''}`);
    }
    let fresh = 0;
    for (const m of html.matchAll(/<a\b[^>]*href="(?:https?:\/\/techjobsforgood\.com)?\/companies\/([a-z0-9][a-z0-9-]*)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const slug = m[1].toLowerCase();
      // The link reads "Company Name Jobs", so drop the trailing word.
      const text = m[2].replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim().replace(/\s+Jobs$/i, '');
      if (!bySlug.has(slug)) { bySlug.set(slug, ''); fresh++; }
      if (text && /[a-z]/i.test(text) && !bySlug.get(slug)) bySlug.set(slug, text);
    }
    if (!fresh) { if (p > 1) console.log(`Tech Jobs for Good: page ${p} had no new companies, stopping`); break; }
    await wait(1500);
  }
  return [...bySlug.entries()].map(([slug, text]) => text || slug.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '));
}

// ---------- Working out which platform a company uses ----------

async function probeGreenhouse(slug) {
  const meta = await http(`https://boards-api.greenhouse.io/v1/boards/${slug}`);
  if (meta.transient) return { transient: true };
  if (!meta.res?.ok) return null;
  let m;
  try { m = await meta.res.json(); } catch { return null; }
  const jobs = await http(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
  let count = null;
  if (jobs.res?.ok) { try { count = ((await jobs.res.json()).jobs || []).length; } catch {} }
  return { method: 'greenhouse', slug, boardName: m.name || '', jobCount: count };
}

async function probeAshby(slug) {
  const r = await http(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
  if (r.transient) return { transient: true };
  if (!r.res?.ok) return null;
  let j;
  try { j = await r.res.json(); } catch { return null; }
  const jobs = j.jobs || [];
  if (!jobs.length) return null;
  return { method: 'ashby', slug, jobCount: jobs.length, texts: jobs.slice(0, 8).map((x) => `${x.title || ''} ${x.descriptionPlain || ''}`) };
}

async function probeLever(slug) {
  const r = await http(`https://api.lever.co/v0/postings/${slug}?mode=json&limit=8`);
  if (r.transient) return { transient: true };
  if (!r.res?.ok) return null;
  let arr;
  try { arr = await r.res.json(); } catch { return null; }
  if (!Array.isArray(arr) || !arr.length) return null;
  return { method: 'lever', slug, jobCount: null, texts: arr.slice(0, 8).map((x) => `${x.text || ''} ${x.descriptionPlain || ''} ${x.additionalPlain || ''}`) };
}

// Decides whether a board really belongs to the company.
function classify(hit, name) {
  const { key, tokens } = norm(name);
  const short = key.length < 4;
  if (hit.method === 'greenhouse') {
    const bk = norm(hit.boardName).key;
    if (bk && bk === key) return { status: short ? 'unsure' : 'matched', reason: `Board name matches exactly ("${hit.boardName}")` };
    if (bk && (bk.includes(key) || key.includes(bk))) return { status: 'unsure', reason: `Board is named "${hit.boardName}", which is close but not identical` };
    return null;
  }
  const total = hit.texts.length;
  const n = hit.texts.filter((t) => mentions(t, tokens)).length;
  if (!short && (n >= 2 || (total < 2 && n === 1))) return { status: 'matched', reason: `Company is named in ${n} of ${total} sampled postings` };
  if (n >= 1) return { status: 'unsure', reason: `Company is named in ${n} of ${total} sampled postings` };
  if (hit.slug === key) return { status: 'unsure', reason: 'Board address matches the name, but the postings do not mention the company' };
  return null;
}

async function resolve(name) {
  let best = null;
  for (const slug of slugVariants(name)) {
    for (const probe of [probeGreenhouse, probeAshby, probeLever]) {
      const hit = await probe(slug);
      if (hit?.transient) return { transient: true };
      if (!hit) continue;
      const c = classify(hit, name);
      if (!c) continue;
      const cand = { method: hit.method, slug, boardName: hit.boardName || '', jobCount: hit.jobCount ?? null, ...c };
      if (c.status === 'matched') return cand;
      if (!best) best = cand;
    }
  }
  return best || { status: 'notfound', reason: 'No board found on Greenhouse, Ashby or Lever' };
}

// ---------- Main ----------

const pool = await readJson('pool.json', { entries: [] });
const entries = new Map((pool.entries || []).map((e) => [e.key, e]));

// 1. Your decisions from the Settings page.
let decisions = [];
try { decisions = JSON.parse(process.env.DECISIONS || '[]'); } catch { console.error('Could not read the decisions input, ignoring it'); }
for (const d of Array.isArray(decisions) ? decisions : []) {
  const e = entries.get(d?.key);
  if (!e) { console.log(`Decision for unknown company "${d?.key}" ignored`); continue; }
  if (d.action === 'approve' && e.method && e.slug) { e.status = 'matched'; e.decided = 'approved'; }
  else if (d.action === 'reject') { e.status = 'rejected'; e.decided = 'rejected'; }
  else if (d.action === 'dismiss') { e.status = 'dismissed'; e.decided = 'dismissed'; }
  else console.log(`Decision "${d.action}" for ${e.name} ignored`);
}

// 2. Collect names.
const sources = await readJson('sources.json', []);
const taken = new Set(sources.map((s) => norm(s.name).key));
const blocked = new Set((rules.blocklist || []).map((n) => norm(n).key));
const found = new Map(); // key -> { name, via: Set }
function addName(name, via) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > 80) return;
  const { key } = norm(clean);
  if (!key || taken.has(key) || blocked.has(key)) return;
  if (!found.has(key)) found.set(key, { name: clean, via: new Set() });
  found.get(key).via.add(via);
}
for (const n of await readLines('pool-seed.txt')) addName(n, 'Starter list');
const muse = await museNames();
muse.forEach((n) => addName(n, 'The Muse'));
console.log(`The Muse: ${muse.length} listings read`);
const boardsOn = (id) => (rules.boards || []).some((b) => b.id === id && b.enabled);
if (boardsOn('tjfg')) {
  const tj = await tjfgNames();
  tj.forEach((n) => addName(n, 'Tech Jobs for Good'));
  console.log(`Tech Jobs for Good: ${tj.length} company names found${tj.length ? '' : ' (check the page layout if this stays at zero)'}`);
}

// 3. Register new names, drop any that are now blocked or already in your own sources.
for (const [key, f] of found) {
  const e = entries.get(key);
  if (e) { for (const v of f.via) if (!e.sources.includes(v)) e.sources.push(v); }
  else entries.set(key, { name: f.name, key, status: 'pending', sources: [...f.via], firstFound: nowIso });
}
for (const [key, e] of [...entries]) {
  if (blocked.has(key) || taken.has(key)) entries.delete(key);
}

// 4. Look up platforms for the ones that need it: new names first, then old not-found ones due a retry.
const due = [...entries.values()].filter((e) =>
  e.status === 'pending' ||
  (e.status === 'notfound' && Date.now() - Date.parse(e.lastTried || 0) > RETRY_NOTFOUND_DAYS * DAY));
const batch = due.slice(0, MAX_RESOLVE);
console.log(`${due.length} companies to look up, doing ${batch.length} this run`);
let next = 0;
await Promise.all(Array.from({ length: Math.min(4, batch.length) }, async () => {
  while (next < batch.length) {
    const e = batch[next++];
    const r = await resolve(e.name);
    if (r.transient) { console.log(`${e.name}: platform check was interrupted, will retry next run`); continue; }
    Object.assign(e, { method: r.method, slug: r.slug, boardName: r.boardName, jobCount: r.jobCount, status: r.status, reason: r.reason, lastTried: nowIso });
    if (r.status === 'notfound') { delete e.method; delete e.slug; delete e.boardName; delete e.jobCount; }
    console.log(`${e.name}: ${r.status}${r.method ? ` (${r.method}/${r.slug})` : ''}`);
  }
}));

// 5. Save.
const out = [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
await writeFile(new URL('pool.json', ROOT), JSON.stringify({ updatedAt: nowIso, entries: out }, null, 1) + '\n');
const tally = {};
for (const e of out) tally[e.status] = (tally[e.status] || 0) + 1;
console.log('Pool now:', JSON.stringify(tally));
