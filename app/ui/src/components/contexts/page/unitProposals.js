// The unit page's "Proposed roles" — the pure part. The proposed roles saved in
// the unit's Authorization workbench investigations (M2a), worded the way the
// workbench words them; the workbench's own rule code says who each reaches now.

import { draftFromSaved } from '@ui/components/workbench/workbench.save';
import { effectiveMembers, ruleSentence } from '@ui/components/workbench/workbench.rule';
import { draftShown } from '@ui/components/workbench/workbench.roles';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** How many proposed roles the unit's saved investigations hold (the list endpoint's rows). Pure. */
export const proposalCount = (list) => (list || []).reduce((n, inv) => n + (inv.proposals?.length ?? 0), 0);

/** "3 in 2 investigations" — only the investigations that hold one count. Pure. */
export function proposalSummary(list) {
  const n = proposalCount(list);
  if (n === 0) return 'None saved yet';
  const invs = (list || []).filter(inv => inv.proposals?.length > 0).length;
  return `${n} in ${plural(invs, 'investigation', 'investigations')}`;
}

export const KIND_WORDS = { rule: 'rule-based', requestable: 'requestable' };

/** "27-10-2026". Pure. */
export function dayOf(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
}

/**
 * One row per saved proposed role, newest investigation first, each role in its
 * investigation's order: its name, kind, the rule in one sentence (or "chosen by
 * hand"), how many people it reaches with the unit's people now, how many
 * entitlements, where it is saved — and `colorIdx`, the band index the workbench
 * colours it by (the unit's existing roles come first). `data` is the unit's
 * workbench payload (people, columns, unit). Pure.
 */
export function proposalRows(investigations, data) {
  const existingRoles = data.columns.filter(c => c.isRole).length;
  return investigations.flatMap((inv) => {
    const drafts = draftFromSaved(inv).drafts.map(d => ({ ...d, members: effectiveMembers(d, data.people) }));
    const shown = drafts.filter(draftShown);
    return drafts.map(d => ({
      id: d.id, investigationId: inv.id, investigationName: inv.name, updatedBy: inv.updatedBy, updatedAt: inv.updatedAt,
      name: d.name.trim() || 'Unnamed', kind: KIND_WORDS[d.kind] ?? 'kind not chosen',
      rule: ruleSentence(d, data.unit.displayName, data.people, data.unit.accountable) ?? 'Members chosen by hand',
      members: d.members.size, entitlements: d.entitlements.size,
      colorIdx: shown.includes(d) ? existingRoles + shown.indexOf(d) : null,
    }));
  });
}

/** "4 people · 2 entitlements". Pure. */
export const countsLine = (row) => `${plural(row.members, 'person', 'people')} · ${plural(row.entitlements, 'entitlement', 'entitlements')}`;
