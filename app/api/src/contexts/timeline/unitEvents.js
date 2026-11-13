// A unit's timeline, in words — the pure half (the SQL is unitTimeline.js).
//
// Every event says what happened, to whom, from → to, and who or what did it:
//
//   people      "Lisa Vos joined (list upload)", "Max Jacobs left (HR sync)",
//               "Iris Hendriks' job title changed: Loss adjuster → Senior loss adjuster"
//   roles       "Accountable changed: Sophie Willems → Tom Bakker (analyst)",
//               "Responsible added: Julia Bos (from the source owner)"
//   structure   "Renamed: Claims → Property Claims", "Moved under Claims Handling (was under Northwind)",
//               "Tree adjusted: split by department (by wim)", "Change request raised: …"
//   knowledge   the interview events (contexts/interviews/timelineEvents.js)
//
// The shape is the timeline's ({ at, operation, eventKind, summary, counterparty* })
// plus `category`, `actor` and, for events that come in bursts (a list upload
// adding 40 people at once), `burst` — what the page folds a burst into.

const NONE = '—';

export const CATEGORIES = Object.freeze(['people', 'roles', 'structure', 'knowledge']);

// Context columns whose change is bookkeeping, or shown another way.
const CONTEXT_SKIP_FIELDS = new Set([
  'id', 'createdAt', 'updatedAt', 'lastCalculatedAt', 'directMemberCount', 'totalMemberCount',
  'sourceRunId', 'sourceAlgorithmId', 'ValidFrom', 'ValidTo', 'extendedAttributes',
]);
// Keys of extendedAttributes that only the plugin or the assistant reads.
const EXTENDED_SKIP_KEYS = new Set(['builtWith', 'terms', 'fields', 'resourceTypes', 'term', 'match']);

const PERSON_KINDS = new Set(['Identity', 'Principal']);

/** "jobTitle" → "Job title". Pure. */
export function humanize(key) {
  const words = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function show(v) {
  if (v === null || v === undefined || v === '') return NONE;
  if (Array.isArray(v)) return v.length ? v.join(', ') : NONE;
  if (typeof v === 'object') return JSON.stringify(v);
  if (v === true) return 'yes';
  if (v === false) return 'no';
  return String(v);
}

const event = (at, operation, category, summary, extra = {}) => ({
  at, operation, eventKind: 'unit', category, summary,
  counterpartyKind: null, counterpartyId: null, counterpartyLabel: null, ...extra,
});

const withActor = (summary, actor) => (actor ? `${summary} (${actor})` : summary);

/**
 * Who or what a row's addedBy stands for on this unit: the source sync (an
 * uploaded list reads as one), the rule that derives the tree, the source
 * owner, or an analyst. Pure.
 */
export function actorFor(addedBy, provenance = {}) {
  if (addedBy === 'analyst') return 'analyst';
  if (addedBy === 'sourceOwner') return 'from the source owner';
  if (addedBy === 'algorithm') return provenance.ruleName ? `rule: ${provenance.ruleName}` : 'rule';
  if (addedBy === 'sync') {
    if (provenance.systemType === 'Upload') return provenance.systemName ? `list upload: ${provenance.systemName}` : 'list upload';
    return provenance.systemName ? `${provenance.systemName} sync` : 'sync';
  }
  return addedBy || null;
}

const PERSON_LINK = { Identity: 'identity', Principal: 'user', Resource: 'resource' };

function memberLink(memberType, memberId, name) {
  const kind = PERSON_LINK[memberType];
  return kind ? { counterpartyKind: kind, counterpartyId: memberId, counterpartyLabel: name } : {};
}

/** One membership added or taken away. `joined`: true for an addition. Pure. */
export function membershipEvent({ at, memberType, memberId, addedBy, joined }, { names, provenance }) {
  const person = PERSON_KINDS.has(memberType);
  const name = names.member(memberType, memberId) || 'Someone no longer in the data';
  const actor = actorFor(addedBy, provenance);
  const verb = person ? (joined ? 'joined' : 'left') : (joined ? 'added' : 'removed');
  const noun = person ? ['person', 'people'] : ['member', 'members'];
  return event(at, joined ? 'added' : 'removed', 'people', withActor(`${name} ${verb}`, actor), {
    actor,
    ...memberLink(memberType, memberId, name),
    burst: { key: `people:${verb}:${actor ?? ''}`, one: `${noun[0]} ${verb}`, many: `${noun[1]} ${verb}`, actor },
  });
}

/** The ContextMembers history rows (migration 109) of a unit, as events. Pure. */
export function membershipEvents(rows, deps) {
  return rows.map(r => {
    const m = r.rowData || {};
    return membershipEvent({ at: r.changedAt, memberType: m.memberType, memberId: m.memberId, addedBy: m.addedBy, joined: r.operation === 'I' }, deps);
  });
}

// ─── Roles ───────────────────────────────────────────────────────────────
const holderOf = (row) => row?.principalId || row?.identityId || null;
const holderKind = (row) => (row?.principalId ? 'user' : 'identity');

function roleActor(row, provenance) {
  if (row?.sourceClaimId) return 'from an interview';
  return actorFor(row?.addedBy, provenance);
}

function roleChange(at, before, after, deps) {
  const fromName = deps.names.holder(before) || NONE;
  const toName = deps.names.holder(after) || NONE;
  const actor = roleActor(after, deps.provenance);
  return event(at, 'changed', 'roles', withActor(`${after.role} changed: ${fromName} → ${toName}`, actor), {
    actor, counterpartyKind: holderKind(after), counterpartyId: holderOf(after), counterpartyLabel: toName,
  });
}

function roleSet(at, row, added, deps) {
  const name = deps.names.holder(row) || 'someone no longer in the data';
  const actor = roleActor(row, deps.provenance);
  const words = row.role === 'Accountable'
    ? `Accountable ${added ? 'set' : 'removed'}: ${name}`
    : `Responsible ${added ? 'added' : 'removed'}: ${name}`;
  return event(at, added ? 'added' : 'removed', 'roles', withActor(words, actor), {
    actor, counterpartyKind: holderKind(row), counterpartyId: holderOf(row), counterpartyLabel: name,
  });
}

const ms = (t) => new Date(t).getTime();
const isAccountable = (r, op) => r.operation === op && r.rowData?.role === 'Accountable';

// For each Accountable removed, the Accountable set right after it (within a
// minute, not before it, another holder): index of the removal → index of the set.
function accountablePairs(rows) {
  const pairs = new Map();
  const taken = new Set();
  rows.forEach((r, i) => {
    if (!isAccountable(r, 'D')) return;
    const j = rows.findIndex((o, k) => !taken.has(k) && isAccountable(o, 'I')
      && ms(o.changedAt) >= ms(r.changedAt) && ms(o.changedAt) - ms(r.changedAt) <= 60_000
      && holderOf(o.rowData) !== holderOf(r.rowData));
    if (j >= 0) { pairs.set(i, j); taken.add(j); }
  });
  return { pairs, taken };
}

/**
 * The ContextRoles history rows of a unit, oldest first, as events. An
 * Accountable removed and another set within a minute is one change, A → B. Pure.
 */
export function roleEvents(rows, deps) {
  const { pairs, taken } = accountablePairs(rows);
  const out = [];
  rows.forEach((r, i) => {
    if (taken.has(i)) return;
    const data = r.rowData || {};
    if (pairs.has(i)) {
      const added = rows[pairs.get(i)];
      out.push(roleChange(added.changedAt, data, added.rowData, deps));
    } else if (r.operation === 'U') {
      const prev = r.prevData || {};
      if (holderOf(prev) !== holderOf(data)) out.push(roleChange(r.changedAt, prev, data, deps));
    } else {
      out.push(roleSet(r.changedAt, data, r.operation === 'I', deps));
    }
  });
  return out;
}

// ─── The unit itself ─────────────────────────────────────────────────────
function aliasEvents(at, before, after) {
  const b = new Set(Array.isArray(before) ? before : []);
  const a = new Set(Array.isArray(after) ? after : []);
  return [
    ...[...a].filter(x => !b.has(x)).map(x => event(at, 'added', 'structure', `Also known as: ${x} added`)),
    ...[...b].filter(x => !a.has(x)).map(x => event(at, 'removed', 'structure', `Also known as: ${x} removed`)),
  ];
}

function extendedEvents(at, before = {}, after = {}) {
  const out = aliasEvents(at, before?.aliases, after?.aliases);
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    if (k === 'aliases' || EXTENDED_SKIP_KEYS.has(k) || k.startsWith('_')) continue;
    const from = show(before?.[k]);
    const to = show(after?.[k]);
    if (from !== to) out.push(event(at, 'changed', 'structure', `${humanize(k)}: ${from} → ${to}`));
  }
  return out;
}

function fieldEvent(at, field, from, to, names) {
  if (field === 'displayName') return event(at, 'changed', 'structure', `Renamed: ${show(from)} → ${show(to)}`);
  if (field === 'parentContextId') {
    const was = from ? ` (was under ${names.context(from) || 'a unit no longer here'})` : '';
    const now = to ? `Moved under ${names.context(to) || 'a unit no longer here'}` : 'Moved to the top level';
    return event(at, 'changed', 'structure', `${now}${was}`, to ? { counterpartyKind: 'context', counterpartyId: to, counterpartyLabel: names.context(to) } : {});
  }
  if (field === 'description') return event(at, 'changed', 'structure', 'Description changed', to ? { detail: String(to).slice(0, 300) } : {});
  return event(at, 'changed', 'structure', `${humanize(field)}: ${show(from)} → ${show(to)}`);
}

/** The unit's own Contexts history rows as events. Pure. */
export function contextRowEvents(rows, { names }) {
  const out = [];
  for (const r of rows) {
    if (r.operation === 'I') { out.push(event(r.changedAt, 'added', 'structure', withActor('Unit created', r.rowData?.createdByUser || null))); continue; }
    if (r.operation === 'D') { out.push(event(r.changedAt, 'removed', 'structure', 'Unit deleted')); continue; }
    const prev = r.prevData || {};
    const data = r.rowData || {};
    for (const field of new Set([...Object.keys(prev), ...Object.keys(data)])) {
      if (CONTEXT_SKIP_FIELDS.has(field)) continue;
      if (show(prev[field]) !== show(data[field])) out.push(fieldEvent(r.changedAt, field, prev[field], data[field], names));
    }
    out.push(...extendedEvents(r.changedAt, prev.extendedAttributes, data.extendedAttributes));
  }
  return out;
}

// ─── Change requests and tree adjustments ────────────────────────────────
const CR_CLOSED = { resolved: 'resolved', withdrawn: 'withdrawn' };

/** ChangeRequests history rows of the unit as events (raised, resolved, withdrawn). Pure. */
export function changeRequestEvents(rows) {
  const out = [];
  for (const r of rows) {
    const d = r.rowData || {};
    const category = d.memberId ? 'people' : 'structure';
    const to = d.targetName ? ` — to ${d.targetName}` : '';
    if (r.operation === 'I') {
      out.push(event(r.changedAt, 'added', category, withActor(`Change request raised: ${d.summary}${to}`, d.raisedBy || null), { actor: d.raisedBy || null }));
    } else if (r.operation === 'U' && r.prevData?.requestStatus !== d.requestStatus && CR_CLOSED[d.requestStatus]) {
      out.push(event(r.changedAt, 'changed', category, `Change request ${CR_CLOSED[d.requestStatus]}: ${d.summary}`, d.closedReason ? { detail: d.closedReason } : {}));
    }
  }
  return out;
}

const ADJUSTMENT_STATUS_WORDS = {
  reverted: 'undone', needsDecision: 'needs a decision', orphaned: 'no longer applies', expired: 'expired', matches: 'now matches the source',
};

/** What an adjustment did, from the unit's side. Pure. */
export function adjustmentWords(d, contextId, names) {
  const p = d.payload || {};
  switch (d.op) {
    case 'moveUnit': return `moved under ${names.context(p.toParentId) || 'another unit'}`;
    case 'renameUnit': return `renamed to ${p.name}`;
    case 'moveMember': {
      const who = names.any(d.memberId) || 'a member';
      return p.toUnitId === contextId ? `${who} moved here` : `${who} moved to ${names.context(p.toUnitId) || 'another unit'}`;
    }
    case 'addUnit': return `sub-unit ${p.name} added`;
    case 'splitUnit': return p.attribute ? `split by ${humanize(p.attribute)}` : 'split';
    case 'setManager': return `manager set to ${names.any(p.principalId) || 'someone'}`;
    default: return humanize(d.op || 'change');
  }
}

/** ContextTreeAdjustments history rows that touch the unit, as events. Pure. */
export function adjustmentEvents(rows, contextId, { names }) {
  const out = [];
  for (const r of rows) {
    const d = r.rowData || {};
    const words = adjustmentWords(d, contextId, names);
    if (r.operation === 'I') {
      out.push(event(r.changedAt, 'changed', 'structure', `Tree adjusted: ${words} (by ${d.createdBy})`, { actor: d.createdBy, ...(d.reason ? { detail: d.reason } : {}) }));
    } else if (r.operation === 'U' && r.prevData?.status !== d.status && ADJUSTMENT_STATUS_WORDS[d.status]) {
      out.push(event(r.changedAt, 'changed', 'structure', `Tree adjustment ${ADJUSTMENT_STATUS_WORDS[d.status]}: ${words}`, d.statusDetail ? { detail: d.statusDetail } : {}));
    }
  }
  return out;
}

// ─── The members' own changes ────────────────────────────────────────────
const possessive = (name) => (name.endsWith('s') ? `${name}'` : `${name}'s`);

// What changed about one account, as [operation, words-after-the-name] pairs.
function textChanges(p, d) {
  return ['jobTitle', 'department']
    .filter(f => show(p[f]) !== show(d[f]))
    .map(f => ['changed', `${humanize(f).toLowerCase()} changed: ${show(p[f])} → ${show(d[f])}`]);
}

function managerChange(p, d, names) {
  if (show(p.managerId) === show(d.managerId)) return [];
  return [['changed', `manager changed: ${names.member('Principal', p.managerId) || NONE} → ${names.member('Principal', d.managerId) || NONE}`]];
}

function accountChanges(p, d) {
  const out = [];
  if (p.accountEnabled !== false && d.accountEnabled === false) out.push(['changed', 'account was disabled']);
  if (p.accountEnabled === false && d.accountEnabled === true) out.push(['changed', 'account was enabled again']);
  if (!p.deletedAt && d.deletedAt) out.push(['removed', 'account was deleted in the source']);
  if (p.deletedAt && !d.deletedAt) out.push(['added', 'account was restored in the source']);
  return out;
}

function personFieldEvents(r, names) {
  const d = r.rowData || {};
  const p = r.prevData || {};
  const name = d.displayName || p.displayName || 'Someone';
  const link = { counterpartyKind: 'user', counterpartyId: d.id || p.id, counterpartyLabel: name };
  return [...textChanges(p, d), ...managerChange(p, d, names), ...accountChanges(p, d)]
    .map(([op, words]) => event(r.changedAt, op, 'people', `${possessive(name)} ${words}`, link));
}

/** Principals history rows of the unit's people: what a unit owner cares about. Pure. */
export function personAttributeEvents(rows, { names }) {
  return rows.flatMap(r => personFieldEvents(r, names));
}

/** Newest first; an event without a category is knowledge (the interview events). Pure. */
export function sortEvents(events) {
  return events
    .map(e => (e.category ? e : { ...e, category: 'knowledge' }))
    .sort((a, b) => new Date(b.at) - new Date(a.at));
}
