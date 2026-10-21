// Reads sources.json, pulls open roles from every source that has a feed,
// and writes jobs.json. Run by the GitHub Action, or by hand: node scripts/fetch-jobs.mjs
import { readFile, writeFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const KEEP_CLOSED_DAYS = 30;
const DAY = 864e5;
const HEADERS = { 'User-Agent': 'job-watch personal job tracker', Accept: 'application/json' };

async function getJson(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...HEADERS, ...(init.headers || {}) }, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

// Each adapter returns [{ ext, title, location, url, postedAt }]
const adapters = {
  async greenhouse(src) {
    const data = await getJson(`https://boards-api.greenhouse.io/v1/boards/${src.slug}/jobs`);
    return (data.jobs || []).map((j) => ({
      ext: String(j.id),
      title: j.title,
      location: j.location?.name || '',
      url: j.absolute_url,
      postedAt: j.first_published || j.updated_at || null,
    }));
  },

  async lever(src) {
    const data = await getJson(`https://api.lever.co/v0/postings/${src.slug}?mode=json`);
    return (Array.isArray(data) ? data : []).map((j) => ({
      ext: String(j.id),
      title: j.text,
      location: j.categories?.location || '',
      url: j.hostedUrl,
      postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
    }));
  },

  async ashby(src) {
    const data = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${src.slug}`);
    return (data.jobs || []).map((j) => ({
      ext: String(j.id),
      title: j.title,
      location: [j.location, j.isRemote ? 'Remote' : ''].filter(Boolean).join('; '),
      url: j.jobUrl,
      postedAt: j.publishedAt || null,
    }));
  },

  // Workday career sites share one public search endpoint.
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
    const fresh = await adapter(src);
    const firstRun = prev.length === 0;
    const prevById = new Map(prev.map((j) => [j.id, j]));
    const seen = new Set();

    for (const f of fresh) {
      if (!f.title || !f.ext) continue;
      const id = `${src.id}-${f.ext}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const old = prevById.get(id);
      outJobs.push({
        id,
        sourceId: src.id,
        title: f.title,
        location: f.location || '',
        url: f.url || src.url || '',
        postedAt: f.postedAt || null,
        // First run for a source: trust the posting date so old roles do not all look new.
        firstSeen: old?.firstSeen || (firstRun ? f.postedAt || now : now),
        active: true,
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
    console.log(`${src.name}: ${seen.size} open roles`);
  } catch (err) {
    failed++;
    // Keep what we had so a bad day does not wipe the list.
    outJobs.push(...prev);
    outSources.push({ ...meta, status: 'error', error: String(err.message || err), count: prev.filter((j) => j.active !== false).length });
    console.error(`${src.name}: FAILED (${err.message || err})`);
  }
}

await writeFile(new URL('jobs.json', ROOT), JSON.stringify({ generatedAt: now, sources: outSources, jobs: outJobs }, null, 1) + '\n');
console.log(`Wrote jobs.json with ${outJobs.length} roles from ${tried} feeds (${failed} failed).`);
if (tried > 0 && failed === tried) process.exit(1);
