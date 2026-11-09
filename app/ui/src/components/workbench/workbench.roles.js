// Authorization workbench — business roles the matrix way. Pure.
//
// The grid shows access with the matrix's own cell (components/matrix/MatrixCell:
// describeCell + CellMarkerStrip) and the business roles as the matrix's right-hand
// band (MatrixApLabelCell, getAccessPackageColor): the unit's existing roles, then
// the candidate as "Draft: <name>". What each cell then says, in the matrix's words:
//
//   managed (role colour)  a role the person holds covers it — the candidate too,
//                          for its members ("covered")
//   provisioning gap (!)   a role the person holds (or the candidate, for a member)
//                          assigns it, and they do not have it ("potential gain")
//   held outside (red n)   a role in view hands it out, but none assigns it to this
//                          person — e.g. a candidate entitlement a non-member holds
//   plain                  nothing in view accounts for it — for a member, access
//                          "outside the candidate"; never a removal
// The workbench's own marks (other context, unrelated, needs investigation) have no
// matrix equivalent and sit on top of the cell.

import { describeCell } from '@ui/components/matrix/MatrixCell.helpers';
import { cellKey, MARKS } from './workbench.model';

const KIND_SUFFIX = { rule: ' · rule-based', requestable: ' · requestable' };

/** A proposed role's band label: "Draft: <name>" ("Draft" while it has none), then its kind once chosen. Pure. */
export function draftName(candidate) {
  const name = candidate.name.trim() ? `Draft: ${candidate.name.trim()}` : 'Draft';
  return `${name}${KIND_SUFFIX[candidate.kind] ?? ''}`;
}

/** Does a proposed role show in the band yet? Once it has a member or an entitlement. Pure. */
export const draftShown = (candidate) => candidate.members.size > 0 || candidate.entitlements.size > 0;

/**
 * The roles of the band, in the matrix's order: the unit's existing business
 * roles (most held first, as the columns come), then each proposed role (the
 * session's drafts, in the order made). Each with the people holding it
 * (`holders`), what it Contains, its band index (`idx`, which
 * getAccessPackageColor colours by) and, for a draft, whether it is the `active` one. Pure.
 */
export function bandRoles(columns, cellsByResource, drafts = [], activeId = null) {
  const roles = columns.filter(c => c.isRole).map(c => ({
    id: c.id, displayName: c.displayName, draft: false,
    holders: new Set((cellsByResource.get(c.id) || []).map(x => x.person)),
    contains: new Set(c.contains || []),
  }));
  for (const d of drafts.filter(draftShown)) {
    roles.push({ id: d.id, displayName: draftName(d), draft: true, active: d.id === activeId, holders: d.members, contains: d.entitlements });
  }
  return roles.map((r, idx) => ({ ...r, idx }));
}

const assigns = (role, personKey, resourceId) => role.holders.has(personKey) && role.contains.has(resourceId);

/**
 * The matrix cell's props for one person × resource. `cell` is the observed
 * access (or undefined); `color(idx)` the band colour. An existing role covers a
 * held cell when the API says so (viaRoles); the draft when the person is a member
 * and the resource an entitlement. Pure.
 */
export function cellProps({ cell, personKey, resourceId, roles, color }) {
  if (cell) return heldProps(cell, personKey, resourceId, roles, color);
  const expecting = roles.filter(r => assigns(r, personKey, resourceId));
  if (expecting.length === 0) return {};
  return { provisioningGap: true, gapExpected: 'Direct', apColor: color(expecting[0].idx), apNames: expecting.map(r => r.displayName), apCount: expecting.length };
}

function heldProps(cell, personKey, resourceId, roles, color) {
  const via = new Set(cell.viaRoles || []);
  const covering = roles.filter(r => (r.draft ? assigns(r, personKey, resourceId) : via.has(r.id)));
  const base = { membershipTypes: new Set([cell.type]) };
  if (covering.length > 0) {
    return { ...base, managed: true, apColor: color(covering[0].idx), apNames: covering.map(r => r.displayName), apCount: covering.length };
  }
  const granting = roles.filter(r => r.contains.has(resourceId));
  if (granting.length === 0) return base;
  return {
    ...base,
    heldOutsideCount: granting.length,
    heldOutsideNames: granting.map(r => r.displayName).join(', '),
    heldOutsideHoldsRole: granting.some(r => r.holders.has(personKey)),
  };
}

/**
 * The cell of a person in a role's own column: holding the role is a Direct,
 * managed cell in the role's colour (the role covers itself, as in the matrix);
 * a draft member who does not hold it yet is the role's provisioning gap. Pure.
 */
export function roleCellProps({ role, personKey, cellIndex, color }) {
  const held = role.draft ? null : cellIndex.get(cellKey(personKey, role.id));
  if (held) return { membershipTypes: new Set([held.type]), managed: true, apColor: color(role.idx), apNames: [role.displayName], apCount: 1 };
  if (role.draft && role.holders.has(personKey)) {
    return { provisioningGap: true, gapExpected: 'Direct', apColor: color(role.idx), apNames: [role.displayName], apCount: 1 };
  }
  return {};
}

/** What a cell says in words: the matrix's own tooltip (describeCell), after the analyst's mark. Pure. */
export function cellLabel(props, mark) {
  const { title } = describeCell({ hasMembership: !!props.membershipTypes, ...props });
  const access = title ?? 'Not held';
  return mark ? `${MARKS[mark].label} — ${access}` : access;
}