// Authorization workbench — the pure parts: grouping people, selecting cells,
// composing a candidate role and reading its impact. Nothing here talks to the
// API; the candidate lives in the browser for the session only (Milestone 1).
// Design: docs/architecture/m1-discovery-and-design.md.
//
// Words used on screen and here, never mixed:
//   observed      the person holds it now (the source snapshot the API read)
//   covered       observed, and the candidate would explain it for this member
//   gain          not observed, the candidate would add it for this member
//   outside       observed, not in the candidate — NOT a removal: other grants may
//                 keep it, and nothing here removes anything
//   other         the analyst marked it as belonging to another context (a duty…)
//   unrelated     the analyst marked it unrelated to this investigation (not invalid)
//   investigate   the analyst marked it as needing investigation
// The workbench never says "loss": removing access is not modelled in M1.

// Grouping is optional (the table shows one row per person); 'none' first, the default.
export const DIMENSIONS = Object.freeze([
  { key: 'none', label: 'No grouping' },
  { key: 'activity', label: 'Activity' },
  { key: 'expertise', label: 'Expertise' },
  { key: 'duty', label: 'Duty' },
  { key: 'jobTitle', label: 'Job title' },
]);

export const MARKS = Object.freeze({
  other: { label: 'Other context', short: 'O', hint: 'Belongs to another activity or duty (e.g. works council)' },
  unrelated: { label: 'Unrelated here', short: 'U', hint: 'Not part of this investigation — not a judgement that it is wrong' },
  investigate: { label: 'Needs investigation', short: '?', hint: 'Ask someone before deciding' },
});

// The states a knowledge link may be in (API: contexts/workbench/model.js linkState).
export const SHOWN_STATES = new Set(['confirmed', 'proposed', 'disputed']);

export const cellKey = (personKey, resourceId) => `${personKey}|${resourceId}`;
export const NOT_KNOWN = '__notKnown';

/** The cells by key, for lookups. Pure. */
export function indexCells(cells) {
  return new Map((cells || []).map(c => [cellKey(c.person, c.resourceId), c]));
}

function valuesOf(person, dimension) {
  if (dimension === 'jobTitle') return person.jobTitle ? [{ key: `jt:${person.jobTitle.toLowerCase()}`, name: person.jobTitle, state: 'source' }] : [];
  return (person.knowledge || [])
    .filter(l => l.kind === dimension && SHOWN_STATES.has(l.state))
    .map(l => ({ key: l.name.toLowerCase().replace(/\s+/g, ' ').trim(), name: l.name, state: l.state }));
}

// How strong the evidence for a value is: confirmed (or the source's own job
// title) before disputed before proposed.
const STRENGTH = { source: 3, confirmed: 3, disputed: 2, proposed: 1 };

/** A person's values for the dimension, strongest evidence first (then by name). Pure. */
export function rankedValues(person, dimension) {
  return valuesOf(person, dimension)
    .sort((a, b) => (STRENGTH[b.state] ?? 0) - (STRENGTH[a.state] ?? 0) || a.name.localeCompare(b.name));
}

/**
 * The people in groups for one dimension. A person with several values — the
 * multi-value convention, never one silently chosen — shows:
 *   multi 'each'  in each of their groups: first under the strongest evidence,
 *                 every other appearance a `repeat` that names where else they are
 *                 (`alsoUnder`);
 *   multi 'once'  only under their strongest value.
 * A person with none is in "Not known". Groups largest first, "Not known" last;
 * each group's `count` is the people shown in it. Pure.
 */
export function groupPeople(people, dimension, sortBy = 'name', accessCount = () => 0, multi = 'each') {
  if (dimension === 'none') return [{ key: 'all', label: 'Everyone', count: people.length, rows: sortRows(people.map(p => ({ person: p, alsoUnder: [], repeat: false })), sortBy, accessCount) }];
  const groups = new Map();
  const add = (key, label, row) => {
    if (!groups.has(key)) groups.set(key, { key, label, rows: [], states: new Set() });
    groups.get(key).rows.push(row);
    groups.get(key).states.add(row.state);
  };
  for (const p of people) {
    const values = rankedValues(p, dimension);
    if (values.length === 0) add(NOT_KNOWN, 'Not known', { person: p, alsoUnder: [], repeat: false, state: null });
    const shown = multi === 'once' ? values.slice(0, 1) : values;
    shown.forEach((v, i) => add(v.key, v.name, {
      person: p, state: v.state, repeat: i > 0,
      alsoUnder: values.filter(o => o !== v).map(o => o.name),
    }));
  }
  return [...groups.values()]
    .map(g => ({ key: g.key, label: g.label, count: g.rows.length, rows: sortRows(g.rows, sortBy, accessCount), allProposed: !g.states.has('confirmed') && !g.states.has('source') && !g.states.has('disputed') && g.key !== NOT_KNOWN }))
    .sort((a, b) => (a.key === NOT_KNOWN) - (b.key === NOT_KNOWN) || b.count - a.count || a.label.localeCompare(b.label));
}
function sortRows(rows, sortBy, accessCount) {
  const byName = (a, b) => a.person.displayName.localeCompare(b.person.displayName);
  if (sortBy === 'access') return [...rows].sort((a, b) => accessCount(b.person.key) - accessCount(a.person.key) || byName(a, b));
  if (sortBy === 'jobTitle') return [...rows].sort((a, b) => byTitle(a.person.jobTitle, b.person.jobTitle) || byName(a, b));
  return [...rows].sort(byName);
}

// Job titles alphabetically, people without one last.
function byTitle(a, b) {
  if (!a || !b) return (!a) - (!b);
  return a.localeCompare(b);
}

/** How many columns each person holds. Pure. */
export function accessCounts(cells) {
  const n = new Map();
  for (const c of cells || []) n.set(c.person, (n.get(c.person) ?? 0) + 1);
  return n;
}

/**
 * The rectangle between two grid positions as cell keys: rows and columns are
 * the visible order (`rowKeys`: person keys, top to bottom — a person listed
 * twice is in it twice, harmless; `colIds`: resource ids, left to right). Pure.
 */
export function rangeKeys(rowKeys, colIds, from, to) {
  const [r0, r1] = [Math.min(from.row, to.row), Math.max(from.row, to.row)];
  const [c0, c1] = [Math.min(from.col, to.col), Math.max(from.col, to.col)];
  const out = new Set();
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.add(cellKey(rowKeys[r], colIds[c]));
  return out;
}

/** Toggle a set of keys: all of them in → out; otherwise all in. Pure. */
export function toggleAll(current, keys) {
  const next = new Set(current);
  const all = [...keys].every(k => next.has(k));
  for (const k of keys) { if (all) next.delete(k); else next.add(k); }
  return next;
}

const splitKey = (k) => { const i = k.lastIndexOf('|'); return [k.slice(0, i), k.slice(i + 1)]; };

/** The people and resources a selection touches. Pure. */
export function selectionParts(selection) {
  const people = new Set();
  const resources = new Set();
  for (const k of selection) { const [p, r] = splitKey(k); people.add(p); resources.add(r); }
  return { people, resources };
}

// A proposed role: { id, name, description, baseBusinessRoleId (the role it updates, or null), members, entitlements }.
export const EMPTY_CANDIDATE = Object.freeze({ id: null, name: '', description: '', baseBusinessRoleId: null, members: new Set(), entitlements: new Set() });

/**
 * The selection added to the candidate: its people become members, and the
 * resources the selection holds — only cells the person really holds, so an
 * empty cell in a rectangle adds nothing — become entitlements. Pure.
 */
export function addSelection(candidate, selection, cellIndex) {
  const members = new Set(candidate.members);
  const entitlements = new Set(candidate.entitlements);
  for (const k of selection) {
    const [p, r] = splitKey(k);
    members.add(p);
    if (cellIndex.has(k)) entitlements.add(r);
  }
  return { ...candidate, members, entitlements };
}

/**
 * The share of the members holding each column, highest first — shown beside each
 * entitlement in the panel (it proposes nothing). [{ resourceId, held, share }]. Pure.
 */
export function frequencies(members, columns, cellIndex) {
  const n = members.size;
  if (n === 0) return [];
  return columns
    .map(col => {
      let held = 0;
      for (const p of members) if (cellIndex.has(cellKey(p, col.id))) held++;
      return { resourceId: col.id, held, share: held / n };
    })
    .filter(f => f.held > 0)
    .sort((a, b) => b.share - a.share || a.resourceId.localeCompare(b.resourceId));
}

/** A proposed update of an existing business role: its members and what it Contains. Pure. */
export function candidateFromRole(role, cellsByResource) {
  return {
    baseBusinessRoleId: role.id, name: role.displayName, description: '',
    // How the source assigns it today, when its crawled policies say (else the analyst chooses).
    kind: role.policyKind ?? null,
    members: new Set((cellsByResource.get(role.id) || []).map(c => c.person)),
    entitlements: new Set(role.contains || []),
  };
}

/** The cells per resource. Pure. */
export function cellsByResource(cells) {
  const m = new Map();
  for (const c of cells || []) {
    if (!m.has(c.resourceId)) m.set(c.resourceId, []);
    m.get(c.resourceId).push(c);
  }
  return m;
}

/**
 * What one cell means with the candidate in place:
 *   null         nothing to say (not observed, not proposed)
 *   'covered' | 'gain' | 'outside' | 'other' | 'unrelated' | 'investigate' | 'held'
 * 'held': observed for someone who is not a member — the candidate does not change it.
 * A mark wins over 'outside' (the analyst said why it is outside). Pure.
 */
export function cellImpact({ observed, member, inCandidate, mark }) {
  if (member && inCandidate) return observed ? 'covered' : 'gain';
  if (!observed) return null;
  if (mark) return mark;
  return member ? 'outside' : 'held';
}

/**
 * The impact of the candidate over the members: counts per kind, the people who
 * would gain something, and the members' observed access the candidate leaves
 * outside. Plus the people outside the candidate who already hold most of it
 * (possible members). Pure.
 */
export function impactSummary(candidate, people, cellIndex, marks, visible = null) {
  const counts = { covered: 0, gain: 0, outside: 0, other: 0, unrelated: 0, investigate: 0 };
  const gainers = new Set();
  // With permission filters on (`visible`: the resources shown), only those count;
  // `hidden` says how many permissions of the members or the candidate they leave out.
  const hidden = new Set();
  const counted = (r) => { if (!visible || visible.has(r)) return true; hidden.add(r); return false; };
  for (const p of candidate.members) {
    for (const r of candidate.entitlements) {
      if (!counted(r)) continue;
      const k = cellKey(p, r);
      const kind = cellImpact({ observed: cellIndex.has(k), member: true, inCandidate: true, mark: marks.get(k) });
      counts[kind]++;
      if (kind === 'gain') gainers.add(p);
    }
  }
  for (const c of cellIndex.values()) {
    if (!candidate.members.has(c.person) || candidate.entitlements.has(c.resourceId) || !counted(c.resourceId)) continue;
    counts[cellImpact({ observed: true, member: true, inCandidate: false, mark: marks.get(cellKey(c.person, c.resourceId)) })]++;
  }
  return { counts, gainers: gainers.size, hidden: hidden.size, possibleMembers: possibleMembers(candidate, people, cellIndex) };
}

/** People outside the candidate who already hold all of its entitlements (or share of them). Pure. */
export function possibleMembers(candidate, people, cellIndex, share = 1) {
  const n = candidate.entitlements.size;
  if (n === 0) return [];
  return people.filter(p => {
    if (candidate.members.has(p.key)) return false;
    let held = 0;
    for (const r of candidate.entitlements) if (cellIndex.has(cellKey(p.key, r))) held++;
    return held / n >= share;
  }).map(p => p.key);
}

/** For an update to an existing role: what the candidate adds to and leaves out of its composition. Pure. */
export function roleDelta(candidate, role) {
  if (!role) return { added: [], leftOut: [] };
  const base = new Set(role.contains || []);
  return {
    added: [...candidate.entitlements].filter(r => !base.has(r)),
    leftOut: [...base].filter(r => !candidate.entitlements.has(r)),
  };
}

/** Many columns and enough people to share them: the workbench starts by hiding what one person alone holds. Pure. */
export function startsCrowded(data) {
  return data.columns.length > 120 && data.people.length >= 4;
}
