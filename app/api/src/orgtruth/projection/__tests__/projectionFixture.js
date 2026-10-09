// Shared fixture for the projection tests (plugin.test.js, pluginPrincipals.test.js,
// project.test.js): a small Contoso organisation with every row kind the projection
// must ignore sitting next to the rows it must use.
//
//   P1 Apollo   (Project)  --owner-->    U1 Ada (Person)  --memberOf--> T1 Tango (Team)
//   P2 Borealis (Project)  unlinked; only a *proposed* owner relation to U2
//   P3 Cirrus   (Project)  proposed entity, related to P1, with a link of its own
//   P4 Delta    (Project)  accepted but closed by a full run, with a link of its own
//   U2 Ben      (Person)   a *closed* sponsor relation to P1
//
// Values are chosen so every wrong rule changes a member set: a proposed link (G2),
// an analyst-rejected link (G3), a link of a closed (G8) or proposed (G9) entity, a
// two-hop target (G7 must not reach P1), a rejected identity account (A4).
export const E = {
  P1: 'e0000000-0000-4000-8000-000000000001',
  P2: 'e0000000-0000-4000-8000-000000000002',
  P3: 'e0000000-0000-4000-8000-000000000003',
  P4: 'e0000000-0000-4000-8000-000000000004',
  U1: 'e0000000-0000-4000-8000-000000000011',
  U2: 'e0000000-0000-4000-8000-000000000012',
  T1: 'e0000000-0000-4000-8000-000000000021',
};

const live = { status: 'accepted', validTo: null };
const OBSERVED = new Date('2026-09-30T00:00:00.000Z');
const SRC = 'a0000000-0000-4000-8000-0000000000aa';

function entity(id, entityType, displayName, extra = {}) {
  return { id, entityType, displayName, attributes: {}, sourceId: SRC, observedAt: OBSERVED, ...live, ...extra };
}

export const SOURCE_ID = SRC;

export const entities = [
  entity(E.P1, 'Project', 'Apollo', { attributes: { budget: 100, costCenter: 'CC-7' } }),
  entity(E.P2, 'Project', 'Borealis'),
  entity(E.P3, 'Project', 'Cirrus', { status: 'proposed' }),
  entity(E.P4, 'Project', 'Delta', { validTo: new Date('2026-09-01T00:00:00.000Z') }),
  entity(E.U1, 'Person', 'Ada Contoso'),
  entity(E.U2, 'Person', 'Ben Northwind'),
  entity(E.T1, 'Team', 'Tango'),
];

export const relations = [
  { fromEntityId: E.P1, toEntityId: E.U1, ...live },
  { fromEntityId: E.U1, toEntityId: E.T1, ...live },
  { fromEntityId: E.P2, toEntityId: E.U2, status: 'proposed', validTo: null },
  { fromEntityId: E.P1, toEntityId: E.U2, status: 'accepted', validTo: new Date('2026-09-01T00:00:00.000Z') },
  { fromEntityId: E.P3, toEntityId: E.P1, ...live },
  { fromEntityId: E.U2, toEntityId: E.P2, status: 'rejected', validTo: null },
];

function link(entityId, targetType, targetId, extra = {}) {
  return { entityId, targetType, targetId, status: 'accepted', analystOverride: null, principalId: null, memberOverride: null, ...extra };
}

export const links = [
  link(E.P1, 'Resource', 'G1'),
  link(E.P1, 'Resource', 'G2', { status: 'proposed' }),
  link(E.P1, 'Resource', 'G3', { analystOverride: 'rejected' }),
  link(E.U1, 'Principal', 'A1'),
  link(E.U1, 'Identity', 'I1', { principalId: 'A2' }),
  link(E.U1, 'Identity', 'I1', { principalId: 'A3' }),
  link(E.U1, 'Identity', 'I1', { principalId: 'A4', memberOverride: 'rejected' }),
  link(E.U2, 'Principal', 'B1'),
  link(E.U2, 'Identity', 'I2'),
  link(E.T1, 'Resource', 'G7'),
  link(E.P3, 'Resource', 'G9'),
  link(E.P4, 'Resource', 'G8'),
  link(E.P1, 'Context', 'C1'),
];

// members [{contextExternalId, memberId}] → { externalId: sorted memberIds }
export function memberMap(members) {
  const out = {};
  for (const m of members) (out[m.contextExternalId] ||= []).push(m.memberId);
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}
