// Reads sources.json, pulls open roles from every source that has a feed,
// and writes jobs.json. Run by the GitHub Action, or by hand: node scripts/fetch-jobs.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { PROFILE_HASH, needsScore } from './profile.mjs';

const ROOT = new URL('../', import.meta.url);
const KEEP_CLOSED_DAYS = 30;
const RECHECK_SALARY_DAYS = 7;
const MAX_DESC = 7000; // characters of each description kept for scoring
const DAY = 864e5;
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
    }));
    // Pay ranges are only on each role's own page, so look them up once a week per role.
    const nowMs = Date.now();
    await mapLimit(items, 5, async (it) => {
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
        it.description = stripHtml(d.content).slice(0, MAX_DESC);
        it.salaryCheckedAt = new Date().toISOString();
      } catch {
        it.salary = pickSalary(old); // try again on the next run
      }
    });
    return items;
  },

  async lever(src) {
    const data = await getJson(`https://api.lever.co/v0/postings/${src.slug}?mode=json`);
    return (Array.isArray(data) ? data : []).map((j) => {
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
        description: stripHtml([j.descriptionPlain, j.additionalPlain, ...(j.lists || []).map((l) => `${l.text || ''} ${stripHtml(l.content)}`)].join(' ')).slice(0, MAX_DESC),
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
        description: String(j.descriptionPlain || '').replace(/\s+/g, ' ').trim().slice(0, MAX_DESC),
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
const previous = await readJson('jobs.json', { jobs: [] });
const prevBySource = new Map();
for (const j of previous.jobs || []) {
  if (!prevBySource.has(j.sourceId)) prevBySource.set(j.sourceId, []);
  prevBySource.get(j.sourceId).push(j);
}

const nowMs = Date.now();
const now = new Date(nowMs).toISOString();
const outJobs = [];
const outSources = [];
const descs = {}; // descriptions for roles that need a score; handed to score-jobs.mjs, never published
let tried = 0, failed = 0;

for (const src of sources) {
  const meta = { ...src, lastChecked: now };
  delete meta.slug; delete meta.host; delete meta.tenant; delete meta.site;
  const prev = prevBySource.get(src.id) || [];
  const adapter = adapters[src.method];

  if (!adapter) {
    outSources.push({ ...meta, status: 'link', count: 0 });
    continue;
  }

  tried++;
  try {
    const prevById = new Map(prev.map((j) => [j.id, j]));
    const need = (ext) => needsScore(prevById.get(`${src.id}-${ext}`) || {});
    const fresh = await adapter(src, prevById, need);
    const firstRun = prev.length === 0;
    const seen = new Set();

    for (const f of fresh) {
      if (!f.title || !f.ext) continue;
      const id = `${src.id}-${f.ext}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const old = prevById.get(id);
      const salary = f.salary || pickSalary(old) || {};
      if (f.description && need(f.ext)) descs[id] = f.description;
      outJobs.push({
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
      });
    }

    // Roles that disappeared from the feed stay for a while, marked closed.
    for (const old of prev) {
      if (seen.has(old.id)) continue;
      const closedAt = old.closedAt || now;
      if (nowMs - Date.parse(closedAt) > KEEP_CLOSED_DAYS * DAY) continue;
      outJobs.push({ ...old, active: false, closedAt });
    }

    outSources.push({ ...meta, status: 'live', count: seen.size });
    const withPay = fresh.filter((f) => f.salary && f.salary.salaryMax).length;
    console.log(`${src.name}: ${seen.size} open roles, ${withPay} with a listed salary`);
  } catch (err) {
    failed++;
    // Keep what we had so a bad day does not wipe the list.
    outJobs.push(...prev);
    outSources.push({ ...meta, status: 'error', error: String(err.message || err), count: prev.filter((j) => j.active !== false).length });
    console.error(`${src.name}: FAILED (${err.message || err})`);
  }
}

await writeFile(new URL('jobs.json', ROOT), JSON.stringify({ generatedAt: now, sources: outSources, jobs: outJobs }, null, 1) + '\n');
if (PROFILE_HASH) await writeFile(new URL('.descriptions.json', ROOT), JSON.stringify(descs));
console.log(`Wrote jobs.json with ${outJobs.length} roles from ${tried} feeds (${failed} failed).`);
if (tried > 0 && failed === tried) process.exit(1);
