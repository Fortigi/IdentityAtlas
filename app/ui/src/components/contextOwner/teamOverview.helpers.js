// The words of the team overview (TeamOverview.jsx). The people's names are
// links, so a sentence is only the text after them.

const SENTENCES = {
  joined: () => ' joined the team',
  left: () => ' left the team',
  'role-added': (c) => ` received ${c.roleName}`,
  'role-removed': (c, count) => ` no longer ${count === 1 ? 'has' : 'have'} ${c.roleName}`,
};

export function changeSentence(change, count = 1) {
  return SENTENCES[change.type]?.(change, count) ?? '';
}

export function changeTone(change) {
  return change.type === 'joined' || change.type === 'role-added' ? 'added' : 'removed';
}

export function ungovernedLabel(person) {
  const noun = person.permissions === 1 ? 'permission' : 'permissions';
  return `${person.displayName}: ${person.ungoverned} of ${person.permissions} ${noun} not covered by a business role`;
}

// The primary type of a person's role (ontology: ia:BusinessRoleControl), the
// same words the business role pages use: a rule adds and removes it, a person
// decided, or the source does not say.
export const ORIGIN_KINDS = Object.freeze({
  automatic: { label: 'Rule based', help: 'a rule adds and removes it, no periodic review needed' },
  manual: { label: 'Manual', help: 'requested and approved, or assigned; needs a periodic review' },
  unknown: { label: 'Unknown', help: 'the source does not say how it was assigned' },
});

export function originKind(control) {
  if (control === 'Automatic') return 'automatic';
  return control === 'Manual' ? 'manual' : 'unknown';
}

/** The kinds present in these roles, in legend order. Pure. */
export function originKindsIn(roles) {
  const present = new Set(roles.flatMap(r => Object.values(r.origins || {}).map(o => originKind(o.control))));
  return Object.keys(ORIGIN_KINDS).filter(k => present.has(k));
}

export function roleMarkLabel(person, role, held) {
  const kind = ORIGIN_KINDS[originKind(held?.control)];
  const via = held?.originDetail ? `, ${held.originDetail}` : '';
  return `${person} holds ${role}: ${kind.label.toLowerCase()} (${kind.help}${via})`;
}

export const HOW_LABEL = Object.freeze({ Indirect: 'Inherited', Eligible: 'Eligible' });

const UNGOVERNED_SECTIONS = [
  { key: 'groups', label: 'Groups', has: t => t === 'Group' },
  { key: 'apps', label: 'Application roles', has: t => t === 'AppRole' },
  { key: 'owner', label: 'Owner of', has: t => String(t).endsWith('Ownership') },
];

/** The permissions by section, in a fixed order, leaving out empty ones. Pure. */
export function groupUngoverned(items) {
  const sections = [...UNGOVERNED_SECTIONS, { key: 'other', label: 'Other access', has: () => true }]
    .map(s => ({ ...s, items: [] }));
  for (const item of items) sections.find(s => s.has(item.resourceType)).items.push(item);
  return sections.filter(s => s.items.length > 0).map(({ key, label, items: list }) => ({ key, label, items: list }));
}

/** What goes between two names in a list of `total`: ", ", " and " or nothing. */
export function nameSeparator(index, total) {
  if (index >= total - 1) return '';
  return index === total - 2 ? ' and ' : ', ';
}

/**
 * The same change to several people on one day is one line. Keeps the order of
 * first appearance (the API sends newest first); one person appears once.
 */
export function groupChanges(changes) {
  const groups = new Map();
  for (const c of changes) {
    const key = `${String(c.at).slice(0, 10)}|${c.type}|${c.roleName ?? ''}`;
    if (!groups.has(key)) groups.set(key, { key, at: c.at, type: c.type, roleName: c.roleName, people: [] });
    const { people } = groups.get(key);
    if (!people.some(p => p.id === c.personId)) {
      people.push({ id: c.personId, kind: c.personKind, name: c.personName, accessible: c.accessible });
    }
  }
  return [...groups.values()];
}
