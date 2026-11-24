// Pure helpers for the members table in ContextRelationshipsTab.jsx: which
// columns a kind of member has, which of them this page of members fills,
// and what the action cell says in edit mode.

const muted = (value) => <span className="text-gray-600 dark:text-gray-400">{value}</span>;
const pill = (value) => (
  <span className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded px-1.5 py-0.5">{value}</span>
);
const status = (enabled) => (
  <span className={`text-xs rounded px-1.5 py-0.5 ${enabled
    ? 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300'
    : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300'}`}>
    {enabled ? 'Active' : 'Disabled'}
  </span>
);

import EntityLink from '@ui/components/EntityLink';
import HeldTick from './HeldTick';

// The kind of account in plain words; an unknown type is shown as stored.
const ACCOUNT_TYPE_WORDS = {
  User: 'Member',
  Member: 'Member',
  Guest: 'Guest',
  ServicePrincipal: 'Service account',
  ManagedIdentity: 'Service account',
  ServiceAccount: 'Service account',
  AIAgent: 'AI agent',
  MachineAccount: 'Machine account',
};

export function accountTypeWord(principalType) {
  return ACCOUNT_TYPE_WORDS[principalType] || principalType;
}

// The columns after Name, per kind of member — what the API returns for it
// (MEMBER_COLUMNS in routes/contexts/read.js; a resource also gets holderCount,
// its owner and its business roles from contexts/resourceMemberFacts.js). `value` decides whether a
// row has something to show; `render` draws it; `align: 'right'` for numbers.
// What the added sources say about a unit's people is the People overview's.
export const MEMBER_TABLE_COLUMNS = {
  Principal: [
    { label: 'Email', value: m => m.email, render: m => muted(m.email) },
    { label: 'Job title', value: m => m.jobTitle, render: m => muted(m.jobTitle) },
    { label: 'Type', value: m => m.principalType, render: m => pill(accountTypeWord(m.principalType)) },
    { label: 'Status', value: m => m.accountEnabled, render: m => status(m.accountEnabled) },
  ],
  Identity: [
    { label: 'Email', value: m => m.email, render: m => muted(m.email) },
    { label: 'Job title', value: m => m.jobTitle, render: m => muted(m.jobTitle) },
    { label: 'Department', value: m => m.department, render: m => muted(m.department) },
  ],
  Resource: [
    { label: 'Type', value: m => m.resourceType, render: m => pill(m.resourceType) },
    // Cut to one line, so a long description does not push the role columns away.
    {
      label: 'Description', value: m => m.description,
      render: m => <span title={m.description} className="block max-w-[16rem] truncate text-gray-600 dark:text-gray-400">{m.description}</span>,
    },
    { label: 'Status', value: m => m.enabled, render: m => status(m.enabled) },
    // Owner before Users: a left-aligned name next to the right-aligned count
    // ran the two together. A resolved owner links to the account.
    { label: 'Owner', value: m => m.ownerDisplayName, render: (m, ctx) => ownerCell(m, ctx) },
    // An empty list still shows the column: "in no role" is the answer, not a gap.
    // With roles on the page, visibleMemberColumns swaps this for one column per role.
    { label: 'Business roles', value: m => m.businessRoles, render: () => muted('—') },
    {
      label: 'Users', align: 'right', value: m => m.holderCount,
      render: m => <span className="tabular-nums text-gray-700 dark:text-gray-300">{Number(m.holderCount).toLocaleString('en-US')}</span>,
    },
  ],
  System: [
    { label: 'Description', value: m => m.description, render: m => muted(m.description) },
  ],
};

// The owner's name; a link to the account when it resolved to one and the page
// can open it (not in a read-only view). The row itself opens the resource, so
// the click stops here.
function ownerCell(m, { onOpenDetail } = {}) {
  if (!m.ownerPrincipalId || !onOpenDetail) {
    return <span className="text-gray-700 dark:text-gray-300" title={m.ownerEmail || undefined}>{m.ownerDisplayName}</span>;
  }
  return (
    <button type="button" title={m.ownerEmail || undefined}
      className="text-left text-blue-700 dark:text-blue-300 hover:underline"
      onClick={(e) => { e.stopPropagation(); onOpenDetail('user', m.ownerPrincipalId, m.ownerDisplayName); }}>
      {m.ownerDisplayName}
    </button>
  );
}

const ROLE_LINK = 'text-blue-700 hover:underline dark:text-blue-300';

// A role's column heading: its name, read bottom to top so many roles fit side
// by side, opening the role's page where the reader may.
function roleHeader(role, { onOpenDetail } = {}) {
  return (
    <span title={role.displayName} className="inline-block max-h-56 rotate-180 truncate whitespace-nowrap [writing-mode:vertical-rl]">
      <EntityLink kind="access-package" id={role.id} label={role.displayName} accessible={role.accessible} onOpenDetail={onOpenDetail} className={ROLE_LINK} />
    </span>
  );
}

// A tick where the role contains this resource. On a narrow screen the table
// reads as cards, with no heading above the tick, so the role's name sits beside it.
function roleMark(m, role) {
  if (!m.businessRoles?.some(r => r.id === role.id)) {
    return <span className="sr-only">{m.displayName} is not in {role.displayName}</span>;
  }
  const label = `${m.displayName} is in ${role.displayName}`;
  return (
    <span className="inline-flex items-center gap-1">
      <HeldTick label={label} />
      <span aria-hidden="true" className="text-xs text-gray-700 dark:text-gray-300 sm:hidden">{role.displayName}</span>
    </span>
  );
}

// One column per business role on this page of members, by name.
function roleMatrixColumns(members) {
  const roles = new Map();
  for (const m of members) {
    for (const role of m.businessRoles || []) if (!roles.has(role.id)) roles.set(role.id, role);
  }
  return [...roles.values()]
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id))
    .map(role => ({
      key: `role:${role.id}`,
      label: role.displayName,
      matrix: true,
      header: (ctx) => roleHeader(role, ctx),
      cellClass: (m) => (m.businessRoles?.some(r => r.id === role.id) ? '' : 'hidden sm:table-cell'),
      render: (m) => roleMark(m, role),
    }));
}

const hasValue = (v) => v !== null && v !== undefined && v !== '';

// The columns of this kind that at least one member on the page fills — a
// column empty for every row is left out. A cell empty in a shown column
// renders nothing. Resources in business roles get one column per role after
// the fixed columns; with no role on the page the single column says so.
export function visibleMemberColumns(targetType, members) {
  const fixed = (MEMBER_TABLE_COLUMNS[targetType] || [])
    .filter(c => members.some(m => hasValue(c.value(m))))
    .map(c => ({ label: c.label, align: c.align, render: (m, ctx) => (hasValue(c.value(m)) ? c.render(m, ctx) : null) }));
  const roles = targetType === 'Resource' ? roleMatrixColumns(members) : [];
  return roles.length ? [...fixed.filter(c => c.label !== 'Business roles'), ...roles] : fixed;
}

// The action cell of a member row in edit mode (which only a context created
// here has, so every removal lasts):
//   remove   the member can be taken out
//   note     not from this list — shown with sub-units included, where the row
//            may belong to a sub-unit
export function memberRowAction(includeDescendants) {
  if (includeDescendants) {
    return { kind: 'note', text: '—', title: 'Turn off "Include sub-units" to remove members' };
  }
  return { kind: 'remove' };
}
