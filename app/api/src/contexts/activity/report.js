// Context activity — what the Activity section shows, composed from the aggregates.
//
//   defaultPeriod(latest)                     → { from, to }  the 12 calendar months up to the latest date
//   monthsBetween(from, to)                   → ['2026-01', …]
//   peopleGroups({ targetType, aggregates, members, names, months })
//   childSummary({ targetType, children, branchOf, aggregates, members, months })
//
// Pure. Activity is evidence, never membership: a context's CURRENT members are
// compared with who was active on it in the period, and the result is four
// groups —
//   memberAndActive   a member who has activity
//   activeNotMember   a known person (matched at upload) with activity who is not a member
//   memberNoActivity  a member with no activity in the period
//   activeUnknown     activity by a name that matched nobody
// The two middle ones are suggestions for a member review; nothing here acts on
// them. A context of resources or systems has no people to compare: its known
// people are one group, `active`.
//
// The comparison is on the member kind of the context: the person (identityId)
// on a context of people, the account (principalId) on one of accounts; the
// upload filled in both where it could (match.js).

const pad = (n) => String(n).padStart(2, '0');
const monthOf = (date) => date.slice(0, 7);

/** The twelve calendar months ending in the latest date's month; null without activity. */
export function defaultPeriod(latest) {
  if (!latest) return null;
  const [y, m] = latest.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 12, 1));
  return { from: `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}-01`, to: latest };
}

/** Every month from `from` to `to` (YYYY-MM-DD), as YYYY-MM. */
export function monthsBetween(from, to) {
  const out = [];
  let [y, m] = monthOf(from).split('-').map(Number);
  const last = monthOf(to);
  for (let guard = 0; guard < 1200; guard++) {
    const key = `${y}-${pad(m)}`;
    if (key > last) break;
    out.push(key);
    if (m === 12) { y++; m = 1; } else m++;
  }
  return out;
}

const COMPARE_ON = { Identity: 'identityId', Principal: 'principalId' };

/** The column a context's members are compared on, or null for a context of resources or systems. */
export const compareColumn = (targetType) => COMPARE_ON[targetType] ?? null;

// One key per person: their person or account id when matched (the compared one
// first), else the raw address or name.
export function personKey(row, cmp) {
  const order = cmp === 'principalId' ? ['principalId', 'identityId'] : ['identityId', 'principalId'];
  for (const f of order) if (row[f]) return `${f}:${row[f]}`;
  return `raw:${(row.subjectEmail || row.subjectName || '').toLowerCase()}`;
}

const round2 = (n) => Math.round(n * 100) / 100;

/** The unit most rows are in (ties: hours), or null without rows. */
export function primaryUnitOf(aggregates) {
  const rowsByUnit = new Map();
  for (const a of aggregates) rowsByUnit.set(a.unit, (rowsByUnit.get(a.unit) ?? 0) + a.rows);
  let best = null;
  for (const [unit, rows] of rowsByUnit) {
    const bestRows = rowsByUnit.get(best) ?? -1;
    if (rows > bestRows || (rows === bestRows && unit === 'hours')) best = unit;
  }
  return best;
}

function newPerson(row, key) {
  return {
    key, principalId: row.principalId ?? null, identityId: row.identityId ?? null,
    subjectName: row.subjectName ?? null, subjectEmail: row.subjectEmail ?? null,
    known: !key.startsWith('raw:'), amounts: {}, rows: 0, firstDate: row.firstDate, lastDate: row.lastDate, months: new Map(),
  };
}

function addRow(p, row, unit) {
  p.amounts[row.unit] = round2((p.amounts[row.unit] ?? 0) + row.amount);
  p.rows += row.rows;
  if (row.firstDate < p.firstDate) p.firstDate = row.firstDate;
  if (row.lastDate > p.lastDate) p.lastDate = row.lastDate;
  if (row.unit === unit) p.months.set(row.month, (p.months.get(row.month) ?? 0) + row.amount);
  p.principalId ??= row.principalId ?? null;
  p.identityId ??= row.identityId ?? null;
  p.subjectName ??= row.subjectName ?? null;
}

/** Fold aggregate rows into one entry per person (Map key → person). */
export function foldPeople(aggregates, cmp, unit) {
  const people = new Map();
  for (const row of aggregates) {
    const key = personKey(row, cmp);
    if (!people.has(key)) people.set(key, newPerson(row, key));
    addRow(people.get(key), row, unit);
  }
  return people;
}

function present(p, { names, months, unit }) {
  const ids = [p.identityId, p.principalId].filter(Boolean);
  const displayName = ids.map(id => names.get(id)).find(Boolean) ?? p.subjectName ?? p.subjectEmail;
  return {
    displayName, subjectName: p.subjectName, subjectEmail: p.subjectEmail, principalId: p.principalId, identityId: p.identityId,
    amount: round2(p.amounts[unit] ?? 0), amounts: p.amounts, rows: p.rows, firstDate: p.firstDate, lastDate: p.lastDate,
    perMonth: months.map(month => ({ month, amount: round2(p.months.get(month) ?? 0) })),
  };
}

const byAmount = (a, b) => b.amount - a.amount || String(a.displayName).localeCompare(String(b.displayName));
const memberEntry = (m) => ({ displayName: m.displayName, memberId: m.memberId, memberType: m.memberType, email: m.email ?? null });

/**
 * @param {object} args
 * @param {string} args.targetType     the context's member kind
 * @param {object[]} args.aggregates   store.activityAggregates() rows of this context
 * @param {object[]} args.members      store.personMembersOf() rows of this context
 * @param {Map} args.names             id → display name (store.namesOf)
 * @param {string[]} args.months       the period's months
 * @returns {{ unit, comparable, groups: [{ key, people }] }}
 */
export function peopleGroups({ targetType, aggregates, members, names, months }) {
  const cmp = compareColumn(targetType);
  const unit = primaryUnitOf(aggregates);
  const shown = [...foldPeople(aggregates, cmp, unit).values()].map(p => ({ ...present(p, { names, months, unit }), known: p.known }));
  const unknown = shown.filter(p => !p.known);
  const known = shown.filter(p => p.known);
  const strip = (list) => list.map(({ known: _k, ...p }) => p).sort(byAmount);
  if (!cmp) return { unit, comparable: false, groups: [{ key: 'active', people: strip(known) }, { key: 'activeUnknown', people: strip(unknown) }] };

  const memberIds = new Set(members.map(m => m.memberId));
  const activeIds = new Set(known.map(p => p[cmp]).filter(Boolean));
  const isMember = (p) => !!p[cmp] && memberIds.has(p[cmp]);
  return {
    unit,
    comparable: true,
    groups: [
      { key: 'memberAndActive', people: strip(known.filter(isMember)) },
      { key: 'activeNotMember', people: strip(known.filter(p => !isMember(p))) },
      { key: 'memberNoActivity', people: members.filter(m => !activeIds.has(m.memberId)).map(memberEntry)
        .sort((a, b) => String(a.displayName).localeCompare(String(b.displayName))) },
      { key: 'activeUnknown', people: strip(unknown) },
    ],
  };
}

function emptyChild(child, months) {
  return {
    contextId: child.id, displayName: child.displayName, total: 0, people: new Set(), notMember: new Set(), unknown: new Set(),
    months: new Map(months.map(m => [m, 0])),
  };
}

// The members of each context, as Sets of member ids.
function memberSets(members) {
  const sets = new Map();
  for (const m of members) {
    if (!sets.has(m.contextId)) sets.set(m.contextId, new Set());
    sets.get(m.contextId).add(m.memberId);
  }
  return sets;
}

function tally(entry, row, { cmp, unit, sets }) {
  const key = personKey(row, cmp);
  entry.people.add(key);
  if (key.startsWith('raw:')) entry.unknown.add(key);
  else if (cmp && !(row[cmp] && sets.get(row.contextId)?.has(row[cmp]))) entry.notMember.add(key);
  if (row.unit !== unit) return;
  entry.total += row.amount;
  if (entry.months.has(row.month)) entry.months.set(row.month, entry.months.get(row.month) + row.amount);
}

// Members of the sub-unit itself with no activity anywhere below it in the period.
function idleMembers(child, active, { cmp, sets }) {
  if (!cmp) return 0;
  return [...(sets.get(child.id) ?? [])].filter(id => !active.has(id)).length;
}

/**
 * The activity table of a parent: one line per direct sub-unit, each over its
 * whole subtree (a row on a grandchild counts for its child), with the two
 * suggestion counts. "Active, not a member" is judged on the context the row
 * landed on; "member, no activity" counts the sub-unit's own members.
 * @param {object} args
 * @param {string} args.targetType
 * @param {object[]} args.children   the direct sub-units { id, displayName }
 * @param {Map} args.branchOf        context id → the direct sub-unit it lies under
 * @param {object[]} args.aggregates rows on any context below the parent
 * @param {object[]} args.members    store.personMembersOf() rows of those contexts
 * @param {string[]} args.months
 */
export function childSummary({ targetType, children, branchOf, aggregates, members, months }) {
  const cmp = compareColumn(targetType);
  const unit = primaryUnitOf(aggregates);
  const sets = memberSets(members);
  const entries = new Map(children.map(c => [c.id, emptyChild(c, months)]));
  const activeByChild = new Map(children.map(c => [c.id, new Set()]));
  for (const row of aggregates) {
    const branch = branchOf.get(row.contextId);
    const entry = entries.get(branch);
    if (!entry) continue;
    tally(entry, row, { cmp, unit, sets });
    if (cmp && row[cmp]) activeByChild.get(branch).add(row[cmp]);
  }
  const rows = children.map(c => {
    const e = entries.get(c.id);
    return {
      contextId: c.id, displayName: c.displayName, total: round2(e.total), activePeople: e.people.size,
      activeNotMember: e.notMember.size, activeUnknown: e.unknown.size,
      memberNoActivity: idleMembers(c, activeByChild.get(c.id), { cmp, sets }),
      perMonth: months.map(month => ({ month, amount: round2(e.months.get(month)) })),
    };
  }).sort((a, b) => b.total - a.total || a.displayName.localeCompare(b.displayName));
  const perMonth = months.map((month, i) => ({ month, amount: round2(rows.reduce((s, r) => s + r.perMonth[i].amount, 0)) }));
  return { unit, comparable: !!cmp, children: rows, totals: { total: round2(rows.reduce((s, r) => s + r.total, 0)), perMonth } };
}

/** context id → the direct sub-unit of `rootId` it lies under (the sub-unit itself included). */
export function branchMap(rootId, descendants) {
  const parentOf = new Map(descendants.map(d => [d.id, d.parentContextId]));
  const branchOf = new Map();
  for (const d of descendants) {
    let at = d.id;
    for (let guard = 0; guard < 100 && parentOf.get(at) !== rootId && parentOf.has(at); guard++) at = parentOf.get(at);
    if (parentOf.get(at) === rootId) branchOf.set(d.id, at);
  }
  return branchOf;
}
