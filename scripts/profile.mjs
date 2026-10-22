// Shared by fetch-jobs.mjs and score-jobs.mjs.
// The skills profile comes from the RESUME_PROFILE secret, never from a file in the repository.
import { createHash } from 'node:crypto';

export const PROFILE = (process.env.RESUME_PROFILE || '').trim();

// Short fingerprint of the profile. Every score remembers the fingerprint it was made with,
// so changing the profile text marks all earlier scores as out of date.
export const PROFILE_HASH = PROFILE ? createHash('sha256').update(PROFILE).digest('hex').slice(0, 8) : '';

// An open role needs a score when it has none, or when its score came from an older profile.
export function needsScore(job) {
  if (!PROFILE_HASH || !job || job.active === false) return false;
  return !job.match || job.match.p !== PROFILE_HASH;
}
