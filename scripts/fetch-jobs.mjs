// Reads sources.json, pulls open roles from every source that has a feed,
// and writes jobs.json. Run by the GitHub Action, or by hand: node scripts/fetch-jobs.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { needsScore } from './profile.mjs';
import { passes, passesLocation, trimming } from './filters.mjs';
import { poolSource } from './pool-lib.mjs';

const ROOT = new URL('../', import.meta.url);
const KEEP_CLOSED_DAYS = 30;
const RECHECK_SALARY_DAYS = 7;
const MAX_STORE = 12000; // characters of each description kept for display and scoring
const DAY = 864e5;
const skipCache = {}; // roles dropped for pay, so their detail page is not fetched again every day (filled from skip.json)
const HEADERS = { 'User-Agent': 'job-watch personal job tracker', Accept: 'application/json' };

async function getJson(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...HEADERS, ...(init.headers || {}) }, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

// ---- Salary helpers: everything is stored as whole US dollars per year ----

function decodeHtml(s) {
  return String(s || '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
}
function stripHtml(s) {
  return decodeHtml(decodeHtml(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// HTML to readable text that keeps paragraph breaks and bullets, for the job detail box.
function htmlToText(html) {
  let s = decodeHtml(html);
  s = s.replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|ul|ol|section|tr)\s*>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<[^>]*>/g, ' ');
  s = decodeHtml(s);
  return s.replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function tidyText(s) {
  return String(s || '').replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const NUM = '(\\d{1,3}(?:,\\d{3})+|\\d{2,3}(?:\\.\\d+)?\\s?[kK])';
const RANGE = new RegExp('\\$\\s?' + NUM + '\\s*(?:-|\\u2013|\\u2014|to)\\s*\\$?\\s?' + NUM, 'g');
function toNumber(s) {
  const t = s.replace(/\s/g, '');
  return /k$/i.test(t) ? Math.round(parseFloat(t) * 1000) : parseInt(t.replace(/,/g, ''), 10);
}
// Last resort: a "$120,000 - $150,000" style range written into the description.
function salaryFromText(text) {
  for (const m of String(text || '').matchAll(RANGE)) {
    const min = toNumber(m[1]), max = toNumber(m[2]);
    if (min >= 20000 && max <= 1000000 && max >= min) return { min, max };
  }
  return null;
}

function annualFactor(interval) {
  const s = String(interval || '').toLowerCase();
  if (/hour/.test(s)) return 2080;
  if (/month/.test(s)) return 12;
  if (/week/.test(s)) return 52;
  if (/day/.test(s)) return 260;
  return 1;
}
function buildSalary({ min, max, currency, interval, source }) {
  if (!(min > 0 || max > 0)) return null;
  if (currency && String(currency).toUpperCase() !== 'USD') {
    return { salaryCurrency: String(currency).toUpperCase(), salarySource: source };
  }
  const f = annualFactor(interval);
  const a = Math.round((min || max) * f), b = Math.round((max || min) * f);
  const lo = Math.min(a, b), hi = Math.max(a, b);
  if (lo < 10000 || hi > 2000000) return null;
  return { salaryMin: lo, salaryMax: hi, salarySource: source };
}
function pickSalary(job) {
  if (!job) return null;
  const out = {};
  for (const k of ['salaryMin', 'salaryMax', 'salarySource', 'salaryCurrency']) if (job[k] != null) out[k] = job[k];
  return Object.keys(out).length ? out : null;
}

// Each adapter returns [{ ext, title, location, url, postedAt, remote, salary }]
const adapters = {
  async greenhouse(src, prevById, need) {
    const data = await getJson(`https://boards-api.greenhouse.io/v1/boards/${src.slug}/jobs`);
    const items = (data.jobs || []).map((j) => ({
      ext: String(j.id),
      title: j.title,
      location: j.location?.name || '',
      url: j.absolute_url,
      postedAt: j.first_published || j.updated_at || null,
      remote: /remote/i.test(j.location?.name || ''),
      salary: null,
      salaryCheckedAt: null,
    })).filter(passesLocation); // skip the per-role pay lookup for roles in the wrong place
    // Pay ranges are only on each role's own page, so look them up once a week per role.
    const nowMs = Date.now();
    await mapLimit(items, 5, async (it) => {
      const skippedAt = skipCache[`${src.id}-${it.ext}`] ? Date.parse(skipCache[`${src.id}-${it.ext}`]) : 0;
      if (skippedAt && nowMs - skippedAt < RECHECK_SALARY_DAYS * DAY) { it.skip = true; return; }
      const old = prevById.get(`${src.id}-${it.ext}`);
      const checked = old?.salaryCheckedAt ? Date.parse(old.salaryCheckedAt) : 0;
      // A role that still needs a match score also needs its description, so it gets looked up now.
      if (checked && nowMs - checked < RECHECK_SALARY_DAYS * DAY && !need(it.ext)) {
        it.salary = pickSalary(old);
        it.salaryCheckedAt = old.salaryCheckedAt;
        return;
      }
      try {
        const d = await getJson(`https://boards-api.greenhouse.io/v1/boards/${src.slug}/jobs/${it.ext}?pay_transparency=true`);
        const ranges = (d.pay_input_ranges || []).filter((r) => r && (r.min_cents || r.max_cents));
        let sal = null;
        if (ranges.length) {
          const usd = ranges.filter((r) => !r.currency_type || r.currency_type === 'USD');
          const pool = usd.length ? usd : ranges;
          sal = buildSalary({
            min: Math.min(...pool.map((r) => (r.min_cents || r.max_cents) / 100)),
            max: Math.max(...pool.map((r) => (r.max_cents || r.min_cents) / 100)),
            currency: pool[0].currency_type || 'USD',
            interval: 'year',
            source: 'feed',
          });
        }
        if (!sal) {
          const r = salaryFromText(stripHtml(d.content));
          if (r) sal = buildSalary({ ...r, currency: 'USD', interval: 'year', source: 'description' });
        }
        it.salary = sal;
        it.description = htmlToText(d.content).slice(0, MAX_STORE);
        it.salaryCheckedAt = new Date().toISOString();
      } catch {
        it.salary = pickSalary(old); // try again on the next run
      }
    });
    return items.filter((it) => !it.skip);
  },

  async lever(src) {
    const data = await getJson(`https://api.lever.co/v0/postings/${src.slug}?mode=json`);
    return (Array.isArray(data) ? data : [])
      // Some companies share one board (Hinge posts on Match Group's). "department" in sources.json keeps only one brand.
      .filter((j) => !src.department || String(j.categories?.department || '').toLowerCase() === String(src.department).toLowerCase())
      .map((j) => {
      const location = j.categories?.location || '';
      let sal = null;
      if (j.salaryRange) {
        sal = buildSalary({ min: j.salaryRange.min, max: j.salaryRange.max, currency: j.salaryRange.currency, interval: j.salaryRange.interval, source: 'feed' });
      }
      if (!sal) {
        const text = [j.descriptionPlain, j.additionalPlain, ...(j.lists || []).map((l) => stripHtml(l.content))].join(' ');
        const r = salaryFromText(text);
        if (r) sal = buildSalary({ ...r, currency: 'USD', interval: 'year', source: 'description' });
      }
      return {
        ext: String(j.id),
        title: j.text,
        location,
        url: j.hostedUrl,
        postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
        remote: String(j.workplaceType || '').toLowerCase() === 'remote' || /remote/i.test(location),
        description: tidyText([j.descriptionPlain, ...(j.lists || []).map((l) => `${l.text || ''}\n${htmlToText(l.content)}`), j.additionalPlain].filter(Boolean).join('\n\n')).slice(0, MAX_STORE),
        salary: sal,
      };
    });
  },

  async ashby(src) {
    const data = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${src.slug}?includeCompensation=true`);
    return (data.jobs || []).map((j) => {
      let sal = null;
      const comps = j.compensation?.summaryComponents || [];
      const c = comps.find((x) => /salary/i.test(x.compensationType || '') && (x.minValue || x.maxValue)) || comps.find((x) => x.minValue || x.maxValue);
      if (c) sal = buildSalary({ min: c.minValue, max: c.maxValue, currency: c.currencyCode, interval: c.interval, source: 'feed' });
      if (!sal) {
        const r = salaryFromText(j.compensation?.compensationTierSummary || '') || salaryFromText(j.descriptionPlain || '');
        if (r) sal = buildSalary({ ...r, currency: 'USD', interval: 'year', source: 'description' });
      }
      return {
        ext: String(j.id),
        title: j.title,
        location: [j.location, j.isRemote && !/remote/i.test(j.location || '') ? 'Remote' : ''].filter(Boolean).join('; '),
        url: j.jobUrl,
        postedAt: j.publishedAt || null,
        remote: !!j.isRemote || String(j.workplaceType || '').toLowerCase() === 'remote' || /remote/i.test(j.location || ''),
        description: (j.descriptionHtml ? htmlToText(j.descriptionHtml) : tidyText(j.descriptionPlain)).slice(0, MAX_STORE),
        salary: sal,
      };
    });
  },

  // Workday career sites share one public search endpoint. It gives no pay data.
  async workday(src) {
    const base = `https://${src.host}/wday/cxs/${src.tenant}/${src.site}/jobs`;
    const out = [];
    for (let offset = 0; offset < 400; offset += 20) {
      const page = await getJson(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: '' }),
      });
      const posts = page.jobPostings || [];
      for (const p of posts) {
        out.push({
          ext: String(p.externalPath || p.title).replace(/[^A-Za-z0-9_-]+/g, '-'),
          title: p.title,
          location: p.locationsText || '',
          url: `https://${src.host}/en-US/${src.site}${p.externalPath}`,
          postedAt: null, // Workday only gives text like "Posted 3 Days Ago"
          remote: /remote/i.test(p.locationsText || ''),
          salary: null,
        });
      }
      if (!posts.length || offset + posts.length >= (page.total || 0)) break;
    }
    return out;
  },
};

async function readJson(name, fallback) {
  try { return JSON.parse(await readFile(new URL(name, ROOT), 'utf8')); } catch { return fallback; }
}

const sources = await readJson('sources.json', []);
// Companies found by discover.mjs and confirmed as matches join the feed. The page keeps them out of "My sources".
for (const e of (await readJson('pool.json', { entries: [] })).entries || []) {
  if (e.status !== 'matched' || !e.method || !e.slug) continue;
  if (sources.some((s) => s.method === e.method && s.slug === e.slug)) continue;
  sources.push(poolSource(e));
}
const previous = await readJson('jobs.json', { jobs: [] });
const prevDescs = await readJson('descriptions.json', {});
Object.assign(skipCache, await readJson('skip.json', {}));
const prevBySource = new Map();
for (const j of previous.jobs || []) {
  if (!prevBySource.has(j.sourceId)) prevBySource.set(j.sourceId, []);
  prevBySource.get(j.sourceId).push(j);
}

const nowMs = Date.now();
const now = new Date(nowMs).toISOString();
const outJobs = [];
const outSources = [];
const outDescs = {}; // descriptions read this run; merged with the ones kept from earlier runs at the end
const skipOut = {};  // roles dropped for pay this run
let tried = 0, failed = 0;

for (const src of sources) {
  const meta = { ...src, lastChecked: now };
  delete meta.slug; delete meta.host; delete meta.tenant; delete meta.site; delete meta.department;
  const prev = prevBySource.get(src.id) || [];
  const adapter = adapters[src.method];

  if (!adapter) {
    outSources.push({ ...meta, status: 'link', count: 0 });
    continue;
  }

  tried++;
  try {
    const prevById = new Map(prev.map((j) => [j.id, j]));
    // A role needs its detail page read when it has no score yet or no stored description.
    const need = (ext) => needsScore(prevById.get(`${src.id}-${ext}`) || {}) || !prevDescs[`${src.id}-${ext}`];
    const fresh = await adapter(src, prevById, need);
    const firstRun = prev.length === 0;
    const seen = new Set();
    let kept = 0;

    for (const f of fresh) {
      if (!f.title || !f.ext) continue;
      const id = `${src.id}-${f.ext}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const old = prevById.get(id);
      const salary = f.salary || pickSalary(old) || {};
      const job = {
        id,
        sourceId: src.id,
        title: f.title,
        location: f.location || '',
        remote: !!f.remote,
        url: f.url || src.url || '',
        postedAt: f.postedAt || null,
        // First run for a source: trust the posting date so old roles do not all look new.
        firstSeen: old?.firstSeen || (firstRun ? f.postedAt || now : now),
        active: true,
        ...salary,
        ...(old?.match ? { match: old.match } : {}),
        ...(f.salaryCheckedAt ? { salaryCheckedAt: f.salaryCheckedAt } : {}),
      };
      // Outside the location or salary filters: not saved, not scored.
      if (!passes(job)) {
        if (src.method === 'greenhouse' && typeof job.salaryMax === 'number') skipOut[id] = now;
        continue;
      }
      if (f.description) outDescs[id] = f.description;
      outJobs.push(job);
      kept++;
    }

    // Roles that disappeared from the feed stay for a while, marked closed.
    for (const old of prev) {
      if (seen.has(old.id) || !passes(old)) continue;
      const closedAt = old.closedAt || now;
      if (nowMs - Date.parse(closedAt) > KEEP_CLOSED_DAYS * DAY) continue;
      outJobs.push({ ...old, active: false, closedAt });
    }

    outSources.push({ ...meta, status: 'live', count: kept });
    const withPay = fresh.filter((f) => f.salary && f.salary.salaryMax).length;
    console.log(`${src.name}: ${trimming ? `${kept} roles kept after filters` : `${seen.size} open roles`}, ${withPay} with a listed salary`);
  } catch (err) {
    failed++;
    // Keep what we had so a bad day does not wipe the list.
    outJobs.push(...prev);
    outSources.push({ ...meta, status: 'error', error: String(err.message || err), count: prev.filter((j) => j.active !== false).length });
    console.error(`${src.name}: FAILED (${err.message || err})`);
  }
}

await writeFile(new URL('jobs.json', ROOT), JSON.stringify({ generatedAt: now, sources: outSources, jobs: outJobs }, null, 1) + '\n');
// Descriptions live in their own file so the page only downloads them when you open a role.
const finalDescs = {};
for (const j of outJobs) {
  const d = outDescs[j.id] || prevDescs[j.id];
  if (d) finalDescs[j.id] = d;
}
await writeFile(new URL('descriptions.json', ROOT), JSON.stringify(finalDescs));
for (const [id, t] of Object.entries(skipCache)) {
  if (!(id in skipOut) && nowMs - Date.parse(t) < RECHECK_SALARY_DAYS * DAY) skipOut[id] = t;
}
await writeFile(new URL('skip.json', ROOT), JSON.stringify(skipOut));
console.log(`Wrote jobs.json with ${outJobs.length} roles from ${tried} feeds (${failed} failed).`);
if (tried > 0 && failed === tried) process.exit(1);
