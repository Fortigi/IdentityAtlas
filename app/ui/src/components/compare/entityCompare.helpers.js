// Pure helpers for the Compare view: line up two or three entities of the same
// kind and show where they differ.
//
// The input is one snapshot per entity, the same shape the Diff tab compares
// (GET /api/<kind>/:id/snapshot):
//
//   { exists, deleted, attributes: { field: value }, relationships: [item] }
//   item = { key, group, label, kind, id, detail }
//
// An item's key names the relationship from the entity's own side (which group,
// held how), so the same group held the same way by two users has the same key
// and lands on one row.

import {
  EXT_PREFIX, attributeDisplayLabel, isEmpty, sameValue, groupRank,
} from '@ui/components/entityDiff.helpers';

export const MAX_COMPARE = 3;

// The compare tab's id is the compared ids joined with commas.
export function parseCompareIds(routeId) {
  const seen = new Set();
  for (const part of String(routeId || '').split(',')) {
    const id = part.trim();
    if (id && !seen.has(id)) seen.add(id);
  }
  return [...seen].slice(0, MAX_COMPARE);
}

export function compareRouteId(ids) {
  return parseCompareIds(ids.join(',')).join(',');
}

// Fields that name or number the account itself. They differ between any two
// accounts by definition, so by default they are hidden — otherwise they fill
// the top of every comparison and push the real differences down.
const PERSONAL_FIELDS = new Set([
  'id', 'externalId', 'displayName', 'givenName', 'surname', 'email', 'mail',
  'mailNickname', 'userPrincipalName', 'onPremisesUserPrincipalName',
  'onPremisesSamAccountName', 'onPremisesSecurityIdentifier', 'onPremisesImmutableId',
  'onPremisesDistinguishedName', 'objectId', 'objectSid', 'employeeId',
  'createdDateTime', 'lastSignInDateTime', 'proxyAddresses', 'imAddresses',
  'otherMails', 'mobilePhone', 'businessPhones',
]);

export function isPersonalField(key) {
  const raw = key.startsWith(EXT_PREFIX) ? key.slice(EXT_PREFIX.length) : key;
  return PERSONAL_FIELDS.has(raw);
}

// Every non-empty value equal → 'same'; otherwise 'differs'. All empty → null
// (the row is left out).
function attributeStatus(values) {
  const present = values.filter(v => !isEmpty(v));
  if (present.length === 0) return null;
  if (present.length < values.length) return 'differs';
  return present.every(v => sameValue(v, present[0])) ? 'same' : 'differs';
}

function compareAttributes(snapshots) {
  const keys = new Set(snapshots.flatMap(s => Object.keys(s?.attributes || {})));
  const rows = [];
  for (const key of keys) {
    const values = snapshots.map(s => s?.attributes?.[key]);
    const status = attributeStatus(values);
    if (!status) continue;
    rows.push({
      key, label: attributeDisplayLabel(key), extended: key.startsWith(EXT_PREFIX),
      personal: isPersonalField(key), values, status,
    });
  }
  return rows.sort((x, y) => (x.extended - y.extended) || x.label.localeCompare(y.label));
}

// A relationship row is the same when every entity has it, held the same way.
function relationshipStatus(items) {
  if (items.some(i => !i)) return 'differs';
  return items.every(i => (i.detail || '') === (items[0].detail || '')) ? 'same' : 'differs';
}

function rowsByKey(snapshots) {
  const rows = new Map();
  snapshots.forEach((s, col) => {
    for (const item of s?.relationships || []) {
      if (!rows.has(item.key)) rows.set(item.key, { key: item.key, group: item.group, items: snapshots.map(() => null) });
      rows.get(item.key).items[col] = item;
    }
  });
  return rows;
}

function compareRelationships(snapshots) {
  const groups = new Map();
  for (const row of rowsByKey(snapshots).values()) {
    row.status = relationshipStatus(row.items);
    if (!groups.has(row.group)) groups.set(row.group, []);
    groups.get(row.group).push(row);
  }
  const labelOf = r => r.items.find(Boolean)?.label || '';
  return [...groups.entries()]
    .sort(([a], [b]) => (groupRank(a) - groupRank(b)) || a.localeCompare(b))
    .map(([group, rows]) => ({
      group,
      rows: rows.sort((x, y) => labelOf(x).localeCompare(labelOf(y))),
      counts: snapshots.map((_, col) => rows.filter(r => r.items[col]).length),
    }));
}

function countStatuses(rows, counts) {
  for (const r of rows) counts[r.status] += 1;
}

// snapshots: one per entity, in column order.
export function compareSnapshots(snapshots) {
  const attributes = compareAttributes(snapshots);
  const groups = compareRelationships(snapshots);
  const counts = { same: 0, differs: 0 };
  countStatuses(attributes.filter(r => !r.personal), counts);
  for (const g of groups) countStatuses(g.rows, counts);
  return { attributes, groups, counts };
}

// What the view shows, from the full comparison and the two switches.
export function visibleComparison(cmp, { onlyDifferences = true, hidePersonal = true } = {}) {
  const keepRow = r => !onlyDifferences || r.status === 'differs';
  return {
    ...cmp,
    attributes: cmp.attributes.filter(r => keepRow(r) && !(hidePersonal && r.personal)),
    groups: cmp.groups
      .map(g => ({ ...g, rows: g.rows.filter(keepRow) }))
      .filter(g => g.rows.length > 0),
  };
}

// PeoplePicker entry for an account, keyed on its id — any principal can be
// compared, also one without a sign-in name (a service principal).
export function toAccount(row) {
  return {
    principalId: row.id,
    userKey: row.id || '',
    displayName: row.displayName || row.userPrincipalName || row.id || '',
    subtitle: row.userPrincipalName || row.email || row.principalType || '',
  };
}

// Name to show for one compared entity.
export function snapshotName(entry) {
  const a = entry?.data?.snapshot?.attributes;
  return a?.displayName || a?.userPrincipalName || entry?.id || '';
}

// The tab label: the compared names, or a count while they load.
export function compareTabLabel(entries) {
  const names = entries.map(snapshotName).filter(Boolean);
  return names.length ? `Compare: ${names.join(' · ')}` : 'Compare';
}
