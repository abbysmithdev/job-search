// Trims what the refresh keeps. Reads filters.json from the repository root.
// If that file is missing, nothing is trimmed.
//   locations: ["nyc", "remote"]   which kinds of location to keep (empty or missing keeps all)
//   minSalary: 85000               drop roles whose top pay is below this (roles with no listed pay are kept)
import { readFileSync } from 'node:fs';

let F = null;
try { F = JSON.parse(readFileSync(new URL('../filters.json', import.meta.url), 'utf8')); } catch {}

export const trimming = !!F;

const NON_US = /canada|toronto|vancouver|mexico|brazil|argentina|colombia|chile|united kingdom|\buk\b|london|ireland|dublin|germany|berlin|france|paris|spain|madrid|portugal|italy|netherlands|amsterdam|poland|europe|emea|apac|latam|india|bengaluru|singapore|japan|tokyo|korea|australia|sydney|israel|dubai|uae|philippines|south africa|nigeria|kenya|china|hong kong|taiwan|new zealand/i;

// Same rules the page uses: New York area, or remote and not tied to another country.
export function locClass({ location, remote }) {
  const loc = location || '';
  const nyc = /new york|nyc|brooklyn|manhattan|queens|bronx/i.test(loc);
  let rem = !!remote || /remote|anywhere/i.test(loc);
  if (rem && !/united states|\bus\b|\busa\b|u\.s\./i.test(loc) && NON_US.test(loc)) rem = false;
  return { nyc, remote: rem };
}

export function passesLocation(job) {
  const want = Array.isArray(F?.locations) ? F.locations : [];
  if (!F || !want.length) return true;
  const c = locClass(job);
  return (want.includes('nyc') && c.nyc) || (want.includes('remote') && c.remote);
}

export function passes(job) {
  if (!F) return true;
  if (!passesLocation(job)) return false;
  const min = Number(F.minSalary) || 0;
  if (min > 0 && typeof job.salaryMax === 'number' && job.salaryMax < min) return false;
  return true;
}
