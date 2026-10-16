// Organisation truth — resolve activity keys: which account, identity, resource or
// list entity a raw value ("Ann Example", "Contoso") stands for.
//
//   decideKey(value, ruleIndexes)          → { status, targetType, targetId, confidence, signals, candidates }   (pure)
//   loadRoleIndexes(recipe, role)          → the rule indexes of that role, in order of preference
//   resolveKeys({ profileName, recipe })   → { actor: n, subject: n } keys (re)decided
//   keyStats(keyIds)                       → { actor: { total, accepted, proposed, unmatched }, subject: {…} }
//
// The linking engine's signals and scoring (linking/score.js) with the generated
// reference rules (referenceRules.js), per distinct value — never per row:
//   best ≥ ACCEPT_AT and no other target of the same type at the same score → accepted
//   best ≥ PROPOSE_AT (or a tie at the top)                                  → proposed (the best one)
//   otherwise                                                                 → unmatched (no target)
// A tie between target TYPES (the same person as account and as identity) is
// not ambiguous: the type listed first in the recipe wins.
// Only keys that are unmatched or proposed and not decided by an analyst are
// (re)decided; the UPDATE repeats that guard, so a decision taken while a run
// resolves is never overwritten.
import { query } from '../../db/connection.js';
import { loadRuleIndexes, ruleKey } from '../linking/candidates.js';
import { scoreEntity, MAX_CANDIDATES } from '../linking/score.js';
import { activityKeyRules, KEY_ENTITY_TYPE } from '../referenceRules.js';
import { ROLES } from './activityWrite.js';

export const ACCEPT_AT = 90;
export const PROPOSE_AT = 60;

const UNRESOLVED_SQL = `
  SELECT "id", "role", "rawValue" FROM "OrgActivityKeys"
   WHERE "profileName" = $1 AND "status" IN ('unmatched', 'proposed') AND NOT "analystOverride"`;

const UPDATE_SQL = `
  UPDATE "OrgActivityKeys" AS k
     SET "status" = u.st, "targetType" = u.tt, "targetId" = u.tid, "confidence" = u.conf, "signals" = u.sig,
         "updatedAt" = now() AT TIME ZONE 'utc'
    FROM unnest($1::uuid[], $2::text[], $3::text[], $4::uuid[], $5::smallint[], $6::text[]) AS u(id, st, tt, tid, conf, sig)
   WHERE k."id" = u.id AND NOT k."analystOverride" AND k."status" IN ('unmatched', 'proposed')`;

const STATS_SQL = `
  SELECT "role", "status", count(*)::int AS n FROM "OrgActivityKeys"
   WHERE "id" = ANY($1::uuid[]) GROUP BY "role", "status"`;

export const keyEntity = (value) => ({ id: null, entityType: KEY_ENTITY_TYPE, displayName: value, attributes: {} });

// Every candidate of every rule, strongest first; on equal scores the rule listed first.
function rankedCandidates(value, ruleIndexes) {
  const all = [];
  ruleIndexes.forEach((ri, order) => {
    for (const c of scoreEntity(keyEntity(value), ri).allCandidates) all.push({ ...c, order });
  });
  return all.sort((a, b) => b.confidence - a.confidence || a.order - b.order || String(a.targetId).localeCompare(String(b.targetId)));
}

const publicCandidate = ({ targetType, targetId, label, confidence }) => ({ targetType, targetId, label, confidence });

export function decideKey(value, ruleIndexes) {
  const ranked = rankedCandidates(value, ruleIndexes);
  const top = ranked[0];
  const candidates = ranked.slice(0, MAX_CANDIDATES).map(publicCandidate);
  if (!top) return { status: 'unmatched', targetType: null, targetId: null, confidence: 0, signals: null, candidates };
  const tie = ranked.some(c => c !== top && c.targetType === top.targetType && c.confidence === top.confidence);
  let status = 'unmatched';
  if (top.confidence >= ACCEPT_AT && !tie) status = 'accepted';
  else if (top.confidence >= PROPOSE_AT) status = 'proposed';
  const target = status === 'unmatched' ? { targetType: null, targetId: null } : { targetType: top.targetType, targetId: top.targetId };
  return { status, ...target, confidence: top.confidence, signals: top.signals.join(','), candidates };
}

export async function loadRoleIndexes(recipe, role) {
  const rules = activityKeyRules(recipe, role);
  const indexes = await loadRuleIndexes(rules);
  return rules.map(r => indexes.get(ruleKey(r)));
}

async function writeDecisions(keys, ruleIndexes) {
  const d = keys.map(k => decideKey(k.rawValue, ruleIndexes));
  await query(UPDATE_SQL, [
    keys.map(k => k.id), d.map(x => x.status), d.map(x => x.targetType), d.map(x => x.targetId),
    d.map(x => x.confidence), d.map(x => x.signals),
  ]);
  return d.length;
}

export async function resolveKeys({ profileName, recipe }) {
  const keys = (await query(UNRESOLVED_SQL, [profileName])).rows;
  const out = { actor: 0, subject: 0 };
  for (const role of ROLES) {
    const mine = keys.filter(k => k.role === role);
    if (mine.length > 0) out[role] = await writeDecisions(mine, await loadRoleIndexes(recipe, role));
  }
  return out;
}

const emptyStats = () => ({ total: 0, accepted: 0, proposed: 0, unmatched: 0 });

/** Counts per role over the given key ids; a rejected key counts as unmatched (it has no target). */
export async function keyStats(keyIds) {
  const ids = ROLES.flatMap(role => [...(keyIds[role]?.values() ?? [])]);
  const out = { actor: emptyStats(), subject: emptyStats() };
  if (ids.length === 0) return out;
  for (const r of (await query(STATS_SQL, [ids])).rows) {
    const s = out[r.role];
    s.total += r.n;
    s[r.status === 'rejected' ? 'unmatched' : r.status] += r.n;
  }
  return out;
}
