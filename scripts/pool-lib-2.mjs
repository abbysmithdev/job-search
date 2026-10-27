// Helpers shared by discover.mjs and fetch-jobs.mjs for the discovered company pool.

// Turns a company name into comparable tokens: lower case, no punctuation, no "Inc" or leading "The".
export function norm(name) {
  let s = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = s.replace(/\([^)]*\)/g, ' ').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  const tokens = s.split(' ').filter(Boolean);
  while (tokens.length > 1 && tokens[0] === 'the') tokens.shift();
  while (tokens.length > 1 && /^(inc|llc|ltd|corp|corporation|co|plc|pbc|incorporated)$/.test(tokens[tokens.length - 1])) tokens.pop();
  return { tokens, key: tokens.join('') };
}

const GENERIC = /^(health|group|technologies|technology|systems|software|labs|foundation|company|international|holdings|partners|network|institute|project)$/;

// Likely board addresses for a company name, for example "Flatiron Health" -> flatironhealth, flatiron-health.
export function slugVariants(name) {
  const { tokens, key } = norm(name);
  if (!key) return [];
  const set = new Set([key, tokens.join('-'), key + 'hq', 'get' + key, key + 'inc']);
  // Boards are often named after the first word ("Oscar Health" -> oscar) or drop a generic last word.
  if (tokens.length > 1) {
    set.add(tokens[0]);
    if (GENERIC.test(tokens[tokens.length - 1])) set.add(tokens.slice(0, -1).join(''));
  }
  return [...set].filter((s) => s.length >= 2 && s.length <= 60);
}

// Does the text name the company as whole words?
export function mentions(text, tokens) {
  if (!tokens.length) return false;
  const hay = ' ' + String(text || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ') + ' ';
  return hay.includes(' ' + tokens.join(' ') + ' ');
}

export function boardUrl(method, slug) {
  if (method === 'greenhouse') return `https://job-boards.greenhouse.io/${slug}`;
  if (method === 'lever') return `https://jobs.lever.co/${slug}`;
  if (method === 'ashby') return `https://jobs.ashbyhq.com/${slug}`;
  return '';
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return '#' + [f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}

// A matched pool company becomes an ordinary feed source, flagged pool: true so the page keeps it out of "My sources".
export function poolSource(e) {
  let h = 0;
  for (const c of e.key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return {
    id: `pool-${e.method}-${e.slug}`,
    name: e.name,
    kind: 'company',
    pool: true,
    method: e.method,
    slug: e.slug,
    url: boardUrl(e.method, e.slug),
    color: hslToHex(h % 360, 45, 32),
    fg: '#FFFFFF',
    note: 'Found by company discovery',
  };
}
