// Context interviews — who a claim is about.
//
//   resolveSubjects(db, names, { contextId, interviewee }) → Map(name → { principalId?, identityId?, match })
//
// A name as spoken in an interview, tried in this order — the first step that
// finds exactly one wins; two candidates are never a guess:
//
//   interviewee  "interviewee" / "I" / "ik" (the reply's word for the speaker), the
//                interviewee's own name, or their first name alone
//   key | name | fuzzy
//                the account matching of a context upload (upload/members.js):
//                e-mail / UPN, employeeId, externalId, then the normalised name and a
//                near miss (lib/nameMatch.js) — user accounts preferred
//   firstName    a first name alone ("Piet") that is the first name of exactly one
//                person the context already knows: a member or a role holder, an
//                account or a person
//
// 'fuzzy' and 'firstName' are flagged in the review list: a person must look
// before confirming. A name that matches nothing keeps its raw text and no holder.

import { buildMatcher, loadCandidates } from '../upload/members.js';
import { normalizeName } from '../../lib/nameMatch.js';
import { likeContains } from '../../db/sqlParams.js';
import { nameSpansIn, PARTICLES } from './nameSpan.js';

const SELF = new Set(['interviewee', 'the interviewee', 'i', 'me', 'myself', 'ik', 'mij', 'mijzelf', 'self']);

const firstWord = (norm) => norm.split(' ')[0];

/** Does `name` (as the reply gives it) mean the interviewee? */
export function isInterviewee(name, intervieweeName) {
  const raw = String(name ?? '').trim().toLowerCase();
  if (SELF.has(raw)) return true;
  const n = normalizeName(name);
  const own = normalizeName(intervieweeName);
  if (!n || !own) return false;
  return n === own || (!n.includes(' ') && n === firstWord(own));
}

const holderOf = (interviewee) => {
  if (interviewee?.principalId) return { principalId: interviewee.principalId };
  if (interviewee?.identityId) return { identityId: interviewee.identityId };
  return {};
};

const escapeLike = (s) => s.replace(/[\\%_]/g, ch => `\\${ch}`);

// The people the context knows whose display name starts with (or, "Last, First",
// carries after the comma) one of the first names. Accounts and persons, members
// and role holders.
export const LOCAL_SQL = `
  SELECT p.id, p."displayName", 'principalId' AS "holderCol"
    FROM "Principals" p
   WHERE p."deletedAt" IS NULL
     AND (p.id IN (SELECT "principalId" FROM "ContextRoles" WHERE "contextId" = $1)
          OR p.id IN (SELECT "memberId" FROM "ContextMembers" WHERE "contextId" = $1 AND "memberType" = 'Principal'))
     AND p."displayName" ILIKE ANY($2::text[])
  UNION ALL
  SELECT i.id, i."displayName", 'identityId' AS "holderCol"
    FROM "Identities" i
   WHERE (i.id IN (SELECT "identityId" FROM "ContextRoles" WHERE "contextId" = $1)
          OR i.id IN (SELECT "memberId" FROM "ContextMembers" WHERE "contextId" = $1 AND "memberType" = 'Identity'))
     AND i."displayName" ILIKE ANY($2::text[])`;

/** The one row whose normalised first name is `first`, or null (none, or two). Pure. */
export function uniqueFirstName(rows, first) {
  const hits = new Map();
  for (const r of rows) {
    if (firstWord(normalizeName(r.displayName)) === first) hits.set(`${r.holderCol}:${r.id}`, r);
  }
  return hits.size === 1 ? [...hits.values()][0] : null;
}

async function localFirstNames(db, contextId, firsts) {
  if (firsts.length === 0) return [];
  const patterns = firsts.flatMap(f => [`${escapeLike(f)} %`, `%, ${escapeLike(f)}%`]);
  return (await db.query(LOCAL_SQL, [contextId, patterns])).rows;
}

/**
 * @param names         distinct subject names (as spoken)
 * @param interviewee   { principalId?, identityId?, name }
 */
export async function resolveSubjects(db, names, { contextId, interviewee }) {
  const out = new Map();
  const rest = [];
  for (const name of names) {
    if (isInterviewee(name, interviewee?.name)) out.set(name, { ...holderOf(interviewee), match: 'interviewee' });
    else rest.push(name);
  }
  if (rest.length === 0) return out;

  const match = buildMatcher('Principal', await loadCandidates(db, 'Principal', rest));
  const leftover = [];
  for (const name of rest) {
    const hit = match(name);
    if (hit?.id) out.set(name, { principalId: hit.id, match: hit.kind });
    else leftover.push(name);
  }

  const singles = leftover.map(n => [n, normalizeName(n)]).filter(([, norm]) => norm && !norm.includes(' '));
  const rows = await localFirstNames(db, contextId, [...new Set(singles.map(([, norm]) => norm))]);
  for (const [name, norm] of singles) {
    const row = uniqueFirstName(rows, norm);
    if (row) out.set(name, { [row.holderCol]: row.id, match: 'firstName' });
  }
  for (const name of leftover) if (!out.has(name)) out.set(name, { match: null });
  return out;
}

// ─── Per claim: the two fallbacks for a name that resolved to nobody ─────
//
//   resolveClaimSubjects(db, claims, opts) → [{ principalId?, identityId?, match, subjectName }] (one per claim)
//
//   quote span   the claim's verbatim quote names the person in full where the
//                model cut the name short ("Hilderink" for "Led Hilderink does…",
//                nameSpan.js): each longer span, longest first, is resolved as above
//                and the first that resolves wins — the claim then carries that name
//   surname      a surname alone ("Vries", "de Vries") that ends the name of exactly
//                ONE live user account; two such accounts, or as many rows as the
//                lookup reads (SURNAME_ROWS), is no match
// Both are flagged 'fuzzy', so the review list asks a person to check.

export const SURNAME_ROWS = 200;

export const SURNAME_SQL = `
  SELECT p.id, p."displayName"
    FROM "Principals" p
   WHERE p."deletedAt" IS NULL AND p."principalType" = 'User' AND p."displayName" ILIKE $1 ESCAPE '\\'
   LIMIT ${SURNAME_ROWS}`;

/** The normalised name when it is a surname alone (particles allowed in front), else null. Pure. */
export function surnameOf(name) {
  const norm = normalizeName(name);
  const parts = norm.split(' ');
  const last = parts[parts.length - 1];
  if (last.length < 3 || !parts.slice(0, -1).every(p => PARTICLES.has(p))) return null;
  return norm;
}

/** The one row whose normalised name ends in ` ${surname}`, or null (none, or two). Pure. */
export function uniqueSurname(rows, surname) {
  const ids = new Set(rows.filter(r => normalizeName(r.displayName).endsWith(` ${surname}`)).map(r => r.id));
  return ids.size === 1 ? [...ids][0] : null;
}

async function bySurname(db, name) {
  const surname = surnameOf(name);
  if (!surname) return null;
  const last = surname.split(' ').pop();
  const { rows } = await db.query(SURNAME_SQL, [likeContains(last)]);
  if (rows.length >= SURNAME_ROWS) return null;
  const id = uniqueSurname(rows, surname);
  return id ? { principalId: id, match: 'fuzzy' } : null;
}

const fuzzyOf = (hit) => ({ ...hit, match: hit.match === 'interviewee' ? 'interviewee' : 'fuzzy' });

async function bySpan(db, unmatched, opts) {
  const spansOf = new Map(unmatched.map(c => [c, nameSpansIn(c.subjectName, c.quote)]));
  const all = [...new Set([...spansOf.values()].flat())];
  if (all.length === 0) return new Map();
  const resolved = await resolveSubjects(db, all, opts);
  const out = new Map();
  for (const [claim, spans] of spansOf) {
    const span = spans.find(s => resolved.get(s)?.match);
    if (span) out.set(claim, { ...fuzzyOf(resolved.get(span)), subjectName: span });
  }
  return out;
}

/**
 * @param claims  checked claims ({ subjectName, quote }); a claim without a subject gets { match: null }
 * @param opts    { contextId, interviewee } as for resolveSubjects
 */
export async function resolveClaimSubjects(db, claims, opts) {
  const names = [...new Set(claims.map(c => c.subjectName).filter(Boolean))];
  const resolved = await resolveSubjects(db, names, opts);
  const unmatched = claims.filter(c => c.subjectName && !resolved.get(c.subjectName).match);
  const fromSpan = await bySpan(db, unmatched, opts);
  const surnames = new Map();
  for (const c of unmatched) {
    if (!fromSpan.has(c) && !surnames.has(c.subjectName)) surnames.set(c.subjectName, await bySurname(db, c.subjectName));
  }
  return claims.map(c => {
    if (!c.subjectName) return { match: null, subjectName: null };
    const hit = fromSpan.get(c) ?? surnames.get(c.subjectName) ?? resolved.get(c.subjectName);
    return { subjectName: c.subjectName, ...hit };
  });
}
