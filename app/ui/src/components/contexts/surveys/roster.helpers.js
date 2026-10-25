// A unit's roster: its people, with what the claims say about each — the view
// an analyst builds by hand in a spreadsheet after the first talk with a line
// manager (docs/architecture/survey-templates.md → the unit roster).
//
//   buildRoster(members, claims) → [{ key, id, name, jobTitle, department, member,
//                                     state, role, responsibleFor, roles, reviewed, claims }]
//
// One row per member, plus one per person the claims name who is not a member
// (someone said they work here, or used to). Per person the newest claim of each
// kind counts (a later survey or interview overrides an earlier one); a
// rejected claim counts for nothing.
//
//   state  'here'     the newest membership claim says current / joined / rejoined
//          'gone'     … former / left
//          'unknown'  no membership claim (nobody has said)
//   role             the newest role claim with relation 'member' (their role, in words)
//   responsibleFor   every role claim with relation 'other' (what they answer for)
//   roles            owner / day-to-day / delegate, as stated
//   reviewed         every claim used is decided (confirmed or edited)
//
// The claims come from GET /api/contexts/:id/claims (ClaimsProvider), the
// members from GET /api/contexts/:id/members. Pure.

const HERE = new Set(['current', 'joined', 'rejoined']);
const GONE = new Set(['former', 'left']);
const STATED_ROLES = { owner: 'Owner', dayToDay: 'Day-to-day', delegate: 'Delegate' };

const keyOf = (c) => {
  if (c.principalId) return `p:${c.principalId}`;
  if (c.identityId) return `i:${c.identityId}`;
  return `n:${String(c.subjectName ?? '').trim().toLowerCase()}`;
};

const newestFirst = (a, b) => String(b.interviewedAt ?? '').localeCompare(String(a.interviewedAt ?? ''))
  || String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));

const isPerson = (c) => c.status !== 'rejected' && (c.subjectKind === 'Person' || (!c.subjectKind && (c.principalId || c.identityId)))
  && (c.claimKind === 'membership' || c.claimKind === 'role');

function stateOf(membership) {
  if (!membership) return 'unknown';
  if (HERE.has(membership.attribute)) return 'here';
  if (GONE.has(membership.attribute)) return 'gone';
  return 'unknown';
}

function summarise(claims) {
  const sorted = [...claims].sort(newestFirst);
  const membership = sorted.find(c => c.claimKind === 'membership');
  const roleClaims = sorted.filter(c => c.claimKind === 'role');
  const role = roleClaims.find(c => c.attribute === 'member');
  const responsible = roleClaims.filter(c => c.attribute === 'other');
  const stated = [...new Set(roleClaims.map(c => STATED_ROLES[c.attribute]).filter(Boolean))];
  const used = [membership, role, ...responsible].filter(Boolean);
  return {
    state: stateOf(membership),
    role: role?.value ?? null,
    responsibleFor: [...new Set(responsible.map(c => c.value))],
    roles: stated,
    reviewed: used.length > 0 && used.every(c => c.status === 'confirmed' || c.status === 'edited'),
    claims: sorted,
  };
}

export function buildRoster(members = [], claims = []) {
  const byKey = new Map();
  for (const c of claims.filter(isPerson)) {
    const k = keyOf(c);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(c);
  }
  const rows = members.map((m) => {
    const ids = [`p:${m.id}`, `i:${m.id}`];
    const own = ids.flatMap(k => byKey.get(k) || []);
    ids.forEach(k => byKey.delete(k));
    return { key: m.id, id: m.id, name: m.displayName || m.id, jobTitle: m.jobTitle ?? null, department: m.department ?? null, member: true, ...summarise(own) };
  });
  for (const [k, own] of byKey) {
    if (!own.some(c => c.claimKind === 'membership')) continue;
    const c = own[0];
    rows.push({ key: k, id: c.principalId ?? c.identityId ?? null, name: c.subjectDisplayName || c.subjectName || '?', jobTitle: null, department: null, member: false, ...summarise(own) });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** How many rows are in each state. */
export function rosterCounts(rows) {
  return rows.reduce((acc, r) => ({ ...acc, [r.state]: (acc[r.state] || 0) + 1 }), { here: 0, gone: 0, unknown: 0 });
}
