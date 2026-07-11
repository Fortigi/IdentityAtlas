// ─── ExpandedItemsList helpers ───────────────────────────────────────
// Pure logic for the entity-graph drill-down list, split out of the .jsx so the
// component file exports only a component (react-refresh) while these stay
// directly unit-testable.

import { friendlyLabel } from '@ui/utils/formatters';

// Counterparty entity-kind labels — the fallback type label when a row has no
// resourceType (e.g. a principal on a resource's member list).
export const ENTITY_LABELS = {
  user:             'User',
  resource:         'Resource',
  'access-package': 'Business Role',
  identity:         'Identity',
  context:          'Context',
  leaf:             '',
};

// The type label for a row: the assignment's resourceType (Group / Group
// Ownership / App Role / …) when present, else the counterparty entity kind.
export function rowType(it) {
  return it.resourceType ? friendlyLabel(it.resourceType) : (ENTITY_LABELS[it.entityKind] || '');
}

// Sort a copy of the items by 'name' (label) or 'type' (rowType), asc/desc,
// case-insensitive, with name as a stable tiebreak. Pure — never mutates input.
export function sortItems(items, key, dir) {
  const mult = dir === 'desc' ? -1 : 1;
  const val = (it) => (key === 'type' ? rowType(it) : (it.label || '')).toLowerCase();
  const tie = (it) => (it.label || '').toLowerCase();
  return [...(items || [])].sort((a, b) => {
    const av = val(a), bv = val(b);
    if (av !== bv) return av < bv ? -mult : mult;
    const at = tie(a), bt = tie(b);
    return at < bt ? -1 : at > bt ? 1 : 0;
  });
}

// Build a CSV (Name, Type, Via) from the items. RFC-4180 quoting. Pure.
export function itemsToCsv(items) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['Name,Type,Via'];
  for (const it of items || []) {
    lines.push([it.label || '', rowType(it), it.via || ''].map(esc).join(','));
  }
  return lines.join('\r\n');
}
