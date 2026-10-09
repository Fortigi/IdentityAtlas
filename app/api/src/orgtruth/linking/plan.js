// Organisation truth — turn score decisions plus the links already stored
// into the writes of one link run (owned by workstream T2). Pure: run.js
// loads, calls planLinkWrites, and executes the plan in one transaction.
//
//   planLinkWrites({ decisions, existing, thresholdFor(decision), runId }) →
//     { upserts: [row], rejectIds: [uuid], counts: { linked, proposed, ambiguous, none, rejected } }
//
// A decision is one (entity, rule, value): an entity with an owner rule and a
// team rule listing three people has four decisions. Precedence, per decision
// (Account Linking's rule: the analyst wins every re-run):
//   1. The entity has a link the analyst confirmed or moved to (analystOverride
//      'confirmed' | 'moved', status 'accepted') for the same target type and the
//      same attribute and value (a link written before 085 has none: it then
//      pins every decision of its target type) → the analyst decided this one:
//      nothing is written for it, it counts as linked.
//   2. Targets the analyst rejected are removed from the candidates and the
//      decision is taken again on what is left (a rejected target is never
//      proposed again).
//   3. accepted → upsert the best candidate as 'accepted';
//      proposed → upsert each kept candidate as 'proposed';
//      none     → nothing.
//   4. Every stored link of the entity without an override that no decision of
//      this run writes again (and that is not rejected yet) is set to
//      'rejected'. Rows are never deleted.
import { decide } from './score.js';

const OVERRIDE_WINS = new Set(['confirmed', 'moved']);
const keyOf = (targetType, targetId) => `${targetType}|${targetId}`;

function groupBy(items, keyFn) {
  const map = new Map();
  for (const it of items ?? []) {
    const k = keyFn(it);
    const list = map.get(k);
    if (list) list.push(it); else map.set(k, [it]);
  }
  return map;
}

// The pinned links that decide this decision: same target type, and the same
// attribute + value when the link recorded them.
function pinnedFor(d, links) {
  return links.filter(l => OVERRIDE_WINS.has(l.analystOverride) && l.status === 'accepted' && l.targetType === d.targetType
    && (l.via == null || (l.via === d.via && (l.orgValue == null || l.orgValue === d.value))));
}

function redecide(d, links, threshold) {
  const rejected = new Set(links.filter(l => l.analystOverride === 'rejected').map(l => keyOf(l.targetType, l.targetId)));
  if (rejected.size === 0) return d;
  const left = d.allCandidates.filter(c => !rejected.has(keyOf(c.targetType, c.targetId)));
  return { ...d, ...decide(left, threshold) };
}

function toRow(entityId, c, status, d, runId) {
  return {
    orgEntityId: entityId, targetType: c.targetType, targetId: c.targetId, confidence: c.confidence,
    // comma-separated names, no spaces around the commas; a comma inside a
    // name would split it in the UI, so it becomes a space
    signals: c.signals.map(n => String(n).replaceAll(',', ' ').trim()).join(','), matchedField: c.matchedField, matchedValue: c.matchedValue,
    via: d.via ?? null, orgValue: d.value || null,
    status, runId,
  };
}

function tally(counts, d) {
  if (d.decision === 'accepted') counts.linked += 1;
  else if (d.decision === 'none') counts.none += 1;
  else if (d.ambiguous) counts.ambiguous += 1;
  else counts.proposed += 1;
}

function planEntity(entityId, group, links, thresholdFor, runId, out) {
  const kept = new Set(links.filter(l => l.analystOverride).map(l => keyOf(l.targetType, l.targetId)));
  // A target type the analyst decided on (a pinned decision) keeps its other
  // stored links too: the engine neither adds to nor prunes what was settled.
  const settledTypes = new Set();
  for (const raw of group) {
    if (pinnedFor(raw, links).length > 0) { out.counts.linked += 1; settledTypes.add(raw.targetType); continue; }
    const d = redecide(raw, links, thresholdFor(raw));
    tally(out.counts, d);
    if (d.decision === 'none') continue;
    const status = d.decision === 'accepted' ? 'accepted' : 'proposed';
    for (const c of d.candidates) {
      out.upserts.push(toRow(entityId, c, status, d, runId));
      kept.add(keyOf(c.targetType, c.targetId));
    }
  }
  for (const l of links) {
    if (l.analystOverride || l.status === 'rejected' || kept.has(keyOf(l.targetType, l.targetId)) || settledTypes.has(l.targetType)) continue;
    out.rejectIds.push(l.id);
  }
}

export function planLinkWrites({ decisions, existing, thresholdFor, runId }) {
  const linksByEntity = groupBy(existing, l => l.orgEntityId);
  const out = { upserts: [], rejectIds: [], counts: { linked: 0, proposed: 0, ambiguous: 0, none: 0, rejected: 0 } };
  for (const [entityId, group] of groupBy(decisions, d => d.entity.id)) {
    planEntity(entityId, group, linksByEntity.get(entityId) ?? [], thresholdFor, runId, out);
  }
  out.counts.rejected = out.rejectIds.length;
  return out;
}
