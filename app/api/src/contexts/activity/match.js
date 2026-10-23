// Context activity — which context a row lands on, and who did it.
//
//   matchContexts(units, values, { self }) → { ids: Map(value → contextId), outcome, stats }    pure
//   namesAUnit(units)              → (value) → true when it is a unit's key or normalised name    pure
//   matchSubjects(db, subjects)    → { resolved: Map(key → { principalId, identityId, kind }), stats }
//   subjectKey({ subjectName, subjectEmail }) → the key one person's rows share
//
// Contexts. A row's unit value is compared with the context the export is
// uploaded on and every context below it (the whole subtree, every level).
// The uploaded-on context comes first: a value that is its own key or name
// lands on it, whatever lies below. Then the subtree: first the key (the
// context's externalId, case-insensitive), then the name through the shared
// name matcher (lib/nameMatch.js: normalised-equal, then a near miss reported
// as fuzzy). A value two units of the subtree share — at one level or at two —
// is ambiguous, and its rows are not imported: never guessed.
//
// People. The list upload's member matching (upload/members.js loadCandidates +
// buildMatcher) does the work, for accounts and for people both: the e-mail
// address first, then the name. A subject matched only as an account gets its
// person through IdentityMembers; one matched only as a person gets that
// person's primary account — so the comparison with a context's members works
// whether the context groups people or accounts.

import { buildNameMatcher, normalizeName } from '../../lib/nameMatch.js';
import { loadCandidates, buildMatcher, emptyStats, countHit, countMiss } from '../upload/members.js';

const fold = (v) => String(v ?? '').trim().toLowerCase();

/** The key one person's rows share: the address when there is one, else the name. */
export const subjectKey = (s) => (s.subjectEmail ? `e:${fold(s.subjectEmail)}` : `n:${fold(s.subjectName)}`);

function keyIndex(units) {
  const index = new Map();
  for (const u of units) {
    const k = fold(u.externalId);
    if (!k) continue;
    if (!index.has(k)) index.set(k, new Set());
    index.get(k).add(u.id);
  }
  return index;
}

/**
 * (value) → true when it is the key or the normalised name of one of `units` —
 * the cheap, exact test the guess scores a column with (no near misses).
 */
export function namesAUnit(units) {
  const keys = new Set(units.map(u => fold(u.externalId)).filter(Boolean));
  const names = new Set(units.map(u => normalizeName(u.displayName)).filter(Boolean));
  return (value) => keys.has(fold(value)) || names.has(normalizeName(value));
}

/**
 * (value) → { id, kind } | { ambiguous: true } | null, over `units` ({ id, externalId, displayName })
 * and `self` — the context the upload is made on, whose own key or name wins (kind 'self').
 */
export function buildContextMatcher(units, self = null) {
  const pool = self ? [...units, self] : units;
  const isSelf = self ? namesAUnit([self]) : () => false;
  const byKey = keyIndex(pool);
  const byName = buildNameMatcher(pool.map(u => ({ id: u.id, name: u.displayName })));
  return (value) => {
    if (isSelf(value)) return { id: self.id, kind: 'self' };
    const ids = byKey.get(fold(value));
    if (ids) return ids.size > 1 ? { ambiguous: true } : { id: [...ids][0], kind: 'key' };
    return byName(value);
  };
}

/**
 * @param {object[]} units   the units below: { id, externalId, displayName }
 * @param {Map<string, number>} values  unit value → how many rows carry it
 * @param {{ self?: object }} [opts]  the uploaded-on context ({ id, externalId, displayName })
 * @returns {{ ids: Map<string,string>, outcome: Map<string,string>, stats: object }} ids for the
 *   values that matched, outcome ('ambiguous' | 'unmatched') for the ones that did not; stats as
 *   upload/members.js reports them, each unmatched sample with the rows it holds back.
 */
export function matchContexts(units, values, { self = null } = {}) {
  const match = buildContextMatcher(units, self);
  const ids = new Map();
  const outcome = new Map();
  const stats = emptyStats();
  for (const [value, rows] of values) {
    const hit = match(value);
    if (hit?.id) { ids.set(value, hit.id); countHit(stats, 'Context', value, hit); continue; }
    outcome.set(value, hit?.ambiguous ? 'ambiguous' : 'unmatched');
    countMiss(stats, 'Context', value, !!hit?.ambiguous);
    const sample = stats.unmatchedSamples.at(-1);
    if (sample?.value === value) sample.rows = rows;
  }
  return { ids, outcome, stats };
}

const RANK = { key: 3, name: 2, fuzzy: 1 };

// The e-mail address first, then the name: the first that finds one candidate.
function matchOne(match, subject) {
  const byEmail = subject.subjectEmail ? match(subject.subjectEmail) : null;
  if (byEmail?.id) return byEmail;
  const byName = subject.subjectName ? match(subject.subjectName) : null;
  if (byName?.id) return byName;
  return byEmail?.ambiguous || byName?.ambiguous ? { ambiguous: true } : null;
}

async function matcherFor(db, kind, values) {
  return buildMatcher(kind, await loadCandidates(db, kind, values));
}

// Fill in the other half: an account's person, a person's primary account.
async function completePairs(db, resolved) {
  const accountsOnly = [...resolved.values()].filter(r => r.principalId && !r.identityId).map(r => r.principalId);
  const peopleOnly = [...resolved.values()].filter(r => r.identityId && !r.principalId).map(r => r.identityId);
  const personOf = new Map();
  const accountOf = new Map();
  if (accountsOnly.length) {
    const rows = (await db.query('SELECT "principalId", "identityId" FROM "IdentityMembers" WHERE "principalId" = ANY($1::uuid[])', [accountsOnly])).rows;
    for (const r of rows) if (!personOf.has(r.principalId)) personOf.set(r.principalId, r.identityId);
  }
  if (peopleOnly.length) {
    const rows = (await db.query('SELECT id, "primaryPrincipalId" FROM "Identities" WHERE id = ANY($1::uuid[])', [peopleOnly])).rows;
    for (const r of rows) if (r.primaryPrincipalId) accountOf.set(r.id, r.primaryPrincipalId);
  }
  for (const r of resolved.values()) {
    r.identityId ??= personOf.get(r.principalId) ?? null;
    r.principalId ??= accountOf.get(r.identityId) ?? null;
  }
}

const shown = (s) => s.subjectName || s.subjectEmail;

function better(a, b) {
  if (!a?.id) return b;
  if (!b?.id) return a;
  return RANK[b.kind] > RANK[a.kind] ? b : a;
}

/**
 * @param {{query: Function}} db
 * @param {object[]} subjects  distinct { subjectName, subjectEmail }
 * @returns {Promise<{ resolved: Map<string, {principalId, identityId, kind}>, stats: object }>}
 *   keyed by subjectKey(); stats over the distinct subjects, as upload/members.js reports them.
 */
export async function matchSubjects(db, subjects) {
  const values = [...new Set(subjects.flatMap(s => [s.subjectEmail, s.subjectName]).filter(Boolean))];
  const resolved = new Map();
  const stats = emptyStats();
  if (values.length === 0) return { resolved, stats };
  const matchAccount = await matcherFor(db, 'Principal', values);
  const matchPerson = await matcherFor(db, 'Identity', values);
  for (const s of subjects) {
    const account = matchOne(matchAccount, s);
    const person = matchOne(matchPerson, s);
    const best = better(account, person);
    if (!best?.id) { countMiss(stats, 'Identity', shown(s), !!(account?.ambiguous || person?.ambiguous)); continue; }
    countHit(stats, 'Identity', shown(s), best);
    resolved.set(subjectKey(s), { principalId: account?.id ?? null, identityId: person?.id ?? null, kind: best.kind });
  }
  await completePairs(db, resolved);
  return { resolved, stats };
}
