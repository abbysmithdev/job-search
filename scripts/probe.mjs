// Finds out whether a company posts jobs on Greenhouse, Lever or Ashby.
// Usage: node scripts/probe.mjs "Hinge" "Liquid Death" hingeapp
// Each argument is tried as a board name in a few spellings.
const names = process.argv.slice(2);
if (!names.length) {
  console.log('Usage: node scripts/probe.mjs "Company Name" [more names or slugs]');
  process.exit(0);
}

function candidates(name) {
  const lower = name.toLowerCase().replace(/^the\s+/, '');
  const base = lower.replace(/[^a-z0-9]+/g, ' ').trim();
  return [...new Set([
    base.replace(/\s+/g, ''),
    base.replace(/\s+/g, '-'),
    base.split(' ')[0],
    base.replace(/\s+/g, '') + 'hq',
    base.replace(/\s+/g, '') + 'inc',
    base.replace(/\s+/g, '') + 'app',
  ])].filter(Boolean);
}

const tests = {
  greenhouse: async (s) => {
    const d = await (await fetch(`https://boards-api.greenhouse.io/v1/boards/${s}/jobs`)).json();
    return d.jobs?.length ? { n: d.jobs.length, sample: d.jobs[0].title, url: d.jobs[0].absolute_url } : null;
  },
  lever: async (s) => {
    const d = await (await fetch(`https://api.lever.co/v0/postings/${s}?mode=json`)).json();
    return Array.isArray(d) && d.length ? { n: d.length, sample: d[0].text, url: d[0].hostedUrl } : null;
  },
  ashby: async (s) => {
    const d = await (await fetch(`https://api.ashbyhq.com/posting-api/job-board/${s}`)).json();
    return d.jobs?.length ? { n: d.jobs.length, sample: d.jobs[0].title, url: d.jobs[0].jobUrl } : null;
  },
};

for (const name of names) {
  console.log(`\n${name}`);
  let found = false;
  for (const slug of candidates(name)) {
    for (const [method, test] of Object.entries(tests)) {
      try {
        const hit = await test(slug);
        if (hit) {
          found = true;
          console.log(`  ${method} / ${slug}: ${hit.n} roles. Example: "${hit.sample}"\n    ${hit.url}`);
        }
      } catch { /* board does not exist under that name */ }
    }
  }
  if (!found) console.log('  Nothing found. The company may use Workday or its own site.');
}
console.log('\nCheck that the example role really belongs to your company before adding it.');
console.log('To add one, copy a greenhouse, lever or ashby entry in sources.json and set "slug".');
