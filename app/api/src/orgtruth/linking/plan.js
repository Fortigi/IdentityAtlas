// Organisation truth — turn score decisions plus the links already stored
// into the writes of one link run (owned by workstream T2). Pure: run.js
// loads, calls planLinkWrites, and executes the plan in one transaction.
//
//   planLinkWrites({ decisions, existing, threshold(rule) }) →
//     { upserts: [row], rejectIds: [uuid], counts: { linked, proposed, ambiguous, none, rejected } }
//
// Precedence, per entity (Account Linking's rule: the analyst wins every re-run):
//   1. The entity has a link the analyst confirmed or moved to (analystOverride
//      'confirmed' | 'moved' and status 'accepted') → the analyst decided this
//      entity: nothing is written for it, it counts as linked.
//   2. Targets the analyst rejected are removed from the candidates and the
//      decision is taken again on what is left (a rejected target is never
//      proposed again).
//   3. accepted → upsert the best candidate as 'accepted';
//      proposed → upsert each kept candidate as 'proposed';
//      none     → nothing.
//   4. Every stored link of the entity without an override that the new plan
//      does not write (and that is not rejected yet) is set to 'rejected'.
//      Rows are never deleted.
import { decide } from './score.js';

const OVERRIDE_WINS = new Set(['confirmed', 'moved']);
const keyOf = (targetType, targetId) => `${targetType}|${targetId}`;

function groupByEntity(existing) {
  const map = new Map();
  for (const l of existing ?? []) {
    const list = map.get(l.orgEntityId);
    if (list) list.push(l); else map.set(l.orgEntityId, [l]);
  }
  return map;
}

const isPinned = (links) => links.some(l => OVERRIDE_WINS.has(l.analystOverride) && l.status === 'accepted');

function redecide(d, links, threshold) {
  const rejected = new Set(links.filter(l => l.analystOverride === 'rejected').map(l => keyOf(l.targetType, l.targetId)));
  if (rejected.size === 0) return d;
  const left = d.allCandidates.filter(c => !rejected.has(keyOf(c.targetType, c.targetId)));
  return { ...d, ...decide(left, threshold) };
}

function toRow(entityId, c, status, runId) {
  return {
    orgEntityId: entityId, targetType: c.targetType, targetId: c.targetId, confidence: c.confidence,
    // comma-separated names, no spaces around the commas; a comma inside a
    // name would split it in the UI, so it becomes a space
    signals: c.signals.map(n => String(n).replaceAll(',', ' ').trim()).join(','), matchedField: c.matchedField, matchedValue: c.matchedValue,
    status, runId,
  };
}

function tally(counts, d) {
  if (d.decision === 'accepted') counts.linked += 1;
  else if (d.decision === 'none') counts.none += 1;
  else if (d.ambiguous) counts.ambiguous += 1;
  else counts.proposed += 1;
}

export function planLinkWrites({ decisions, existing, thresholdFor, runId }) {
  const byEntity = groupByEntity(existing);
  const upserts = [];
  const rejectIds = [];
  const counts = { linked: 0, proposed: 0, ambiguous: 0, none: 0, rejected: 0 };

  for (const raw of decisions) {
    const entityId = raw.entity.id;
    const links = byEntity.get(entityId) ?? [];
    if (isPinned(links)) { counts.linked += 1; continue; }

    const d = redecide(raw, links, thresholdFor(raw.entityType));
    tally(counts, d);
    const status = d.decision === 'accepted' ? 'accepted' : 'proposed';
    const writes = d.decision === 'none' ? [] : d.candidates.map(c => toRow(entityId, c, status, runId));
    upserts.push(...writes);

    const kept = new Set(writes.map(w => keyOf(w.targetType, w.targetId)));
    for (const l of links) {
      if (l.analystOverride || l.status === 'rejected' || kept.has(keyOf(l.targetType, l.targetId))) continue;
      rejectIds.push(l.id);
    }
  }
  counts.rejected = rejectIds.length;
  return { upserts, rejectIds, counts };
}
