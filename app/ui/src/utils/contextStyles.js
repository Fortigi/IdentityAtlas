// Visual language for the Contexts tab.
// Two orthogonal dimensions — variant (who produced this context) and
// targetType (what it contains) — each with a distinct visual treatment.
//
// Every text/badge class ships with a dark: variant: these metas are consumed
// raw by every Contexts component, so a missing dark variant breaks the whole
// tab in dark mode (contextStyles.test.js guards against regressions).

export const VARIANT_META = {
  synced:    { label: 'Synced',    borderClass: 'border-blue-500',    dotClass: 'bg-blue-500',    textClass: 'text-blue-700 dark:text-blue-400' },
  generated: { label: 'Generated', borderClass: 'border-emerald-500', dotClass: 'bg-emerald-500', textClass: 'text-emerald-700 dark:text-emerald-400' },
  manual:    { label: 'Manual',    borderClass: 'border-amber-600',   dotClass: 'bg-amber-600',   textClass: 'text-amber-700 dark:text-amber-400' },
};

export const TARGET_TYPE_META = {
  Identity:  { label: 'Identity',  badgeClass: 'bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-700' },
  Resource:  { label: 'Resource',  badgeClass: 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-900/30 dark:text-orange-300 dark:border-orange-700' },
  // Principal gets its own hue (sky) so it isn't visually identical to the Unknown fallback.
  Principal: { label: 'Principal', badgeClass: 'bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-900/30 dark:text-sky-300 dark:border-sky-700' },
  System:    { label: 'System',    badgeClass: 'bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-300 dark:border-yellow-700' },
};

// The four context templates (phase B of the ontology) plus "Other" for a
// context whose contextCategory is null (a contextType the backfill did not
// know). Hues stay clear of the variant (blue/emerald/amber) and target-type
// (purple/orange/sky/yellow) metas so the three dimensions never look alike.
// `groupLabel` is the heading the tree selector groups roots under.
export const CATEGORY_META = {
  OrganizationalUnit: {
    label: 'Organisation', groupLabel: 'Organisation',
    description: 'A unit of the organisation: department, team, cost center, project.',
    badgeClass: 'bg-teal-100 text-teal-800 border-teal-200 dark:bg-teal-900/30 dark:text-teal-300 dark:border-teal-700',
  },
  LogicalApplication: {
    label: 'Application', groupLabel: 'Applications',
    description: 'A logical application: the resources that together make up one system.',
    badgeClass: 'bg-indigo-100 text-indigo-800 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-300 dark:border-indigo-700',
  },
  Tag: {
    label: 'Tag', groupLabel: 'Tags',
    description: 'A label an analyst attaches to anything.',
    badgeClass: 'bg-pink-100 text-pink-800 border-pink-200 dark:bg-pink-900/30 dark:text-pink-300 dark:border-pink-700',
  },
  Segment: {
    label: 'Segment', groupLabel: 'Segments',
    description: 'A slice of the data: a location, a type, a system membership.',
    badgeClass: 'bg-lime-100 text-lime-800 border-lime-200 dark:bg-lime-900/30 dark:text-lime-300 dark:border-lime-700',
  },
};

// Grouping order in the tree selector: the four templates, then Other.
export const CATEGORY_ORDER = ['OrganizationalUnit', 'LogicalApplication', 'Tag', 'Segment', 'Other'];

// The kind of member a context holds, in the words the template screens use:
// people (identities), accounts (principals), resources. A unit exists as one
// context per kind, so these are also the variants of a unit, in this order.
export const MEMBER_KINDS = ['Identity', 'Principal', 'Resource'];
const MEMBER_KIND_LABELS = { Identity: 'People', Principal: 'Accounts', Resource: 'Resources', System: 'Systems' };

export function memberKindLabel(targetType) {
  return MEMBER_KIND_LABELS[targetType] || 'Members';
}

// The kind of member as a lower-case noun for running text, singular for a
// count of 1: "1 person", "12 people", "Search accounts to add". Never built
// from the targetType itself ("identitys" was).
const MEMBER_KIND_NOUNS = {
  Identity: ['person', 'people'],
  Principal: ['account', 'accounts'],
  Resource: ['resource', 'resources'],
  System: ['system', 'systems'],
};

export function memberKindNoun(targetType, count = 2) {
  const [one, many] = MEMBER_KIND_NOUNS[targetType] || ['member', 'members'];
  return count === 1 ? one : many;
}

// ─── Context type in words ──────────────────────────────────────────────
// The stored contextType is a code (ManagerHierarchy, ADMINISTRATIVEUNIT…).
// Known codes get a written label; anything else is split into Title Case
// words. Matching ignores case, spaces, dashes and underscores. A code that
// names no kind of unit (Manual) gives '' — nothing to say.
const CONTEXT_TYPE_LABELS = {
  department: 'Department',
  team: 'Team',
  managerhierarchy: 'Manager hierarchy',
  administrativeunit: 'Administrative unit',
  orphanedaccounts: 'Orphaned accounts',
  orgunit: 'Organisational unit',
  organisationalunit: 'Organisational unit',
  organizationalunit: 'Organisational unit',
  costcenter: 'Cost center',
  businessunit: 'Business unit',
  businessprocess: 'Business process',
  logicalapplication: 'Application',
  principaltype: 'Account type',
  resourcetype: 'Resource type',
  manual: '',
};

function titleCaseWords(code) {
  return String(code)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

export function contextTypeLabel(contextType) {
  if (!contextType) return '';
  const key = String(contextType).toLowerCase().replace(/[^a-z0-9]/g, '');
  return key in CONTEXT_TYPE_LABELS ? CONTEXT_TYPE_LABELS[key] : titleCaseWords(contextType);
}

// ─── Where a context comes from, in words ───────────────────────────────
// The rules that derive contexts (sourceAlgorithmName), described by what they
// read. `withSystem` adds "in <system>" where the system matters to the
// sentence. A rule not listed here is named by its display name.
const RULE_PHRASES = {
  'department-from-principal': { text: 'the department field on each account' },
  department: { text: 'the department field on each person' },
  'manager-hierarchy': { text: 'who reports to whom', withSystem: true },
  'ad-ou-from-dn': { text: 'the directory folder each account sits in', withSystem: true },
  'orphaned-accounts': { text: 'the accounts no person is linked to', withSystem: true },
  'resource-cluster': { text: 'resources held by the same people' },
  'principal-type-tree': { text: 'the type of each account' },
  'resource-type-tree': { text: 'the type of each resource' },
  'entra-group-category-tree': { text: 'the kind of each group', withSystem: true },
  'system-membership-principals': { text: 'the system each account belongs to' },
  'system-membership-resources': { text: 'the system each resource belongs to' },
  'context-recipe': { text: 'a set of search terms' },
};

// What a derived context was derived from: "who reports to whom in Contoso
// EntraID", or 'the rule "K-Means"' for a rule without a phrase.
export function ruleSourcePhrase(attrs) {
  const rule = RULE_PHRASES[attrs?.sourceAlgorithmName];
  const system = attrs?.scopeSystemName;
  if (rule) return rule.withSystem && system ? `${rule.text} in ${system}` : rule.text;
  const name = attrs?.sourceAlgorithmDisplayName || attrs?.sourceAlgorithmName;
  return name ? `the rule "${name}"` : 'a rule';
}

// What derived a context: the rule by the name it has under Admin, so a reader
// can tell which rule made it — "derived by the Department from Principal
// rule"; a rule without a display name is described by what it reads.
function derivedDescription(attrs) {
  const name = attrs.sourceAlgorithmDisplayName;
  return name ? `derived by the ${name} rule` : `derived from ${ruleSourcePhrase(attrs)}`;
}

// "imported from Fortigi Demo HR" / "derived by the … rule" / "created in
// Identity Atlas" — '' for a source we cannot name.
export function sourceDescription(attrs) {
  if (attrs?.variant === 'synced') return `imported from ${attrs.scopeSystemName || 'a connected system'}`;
  if (attrs?.variant === 'generated') return derivedDescription(attrs);
  if (attrs?.variant === 'manual') return 'created in Identity Atlas';
  return '';
}

// The one-line subtitle under a context's name: what it is and where it came
// from — "Department · imported from Fortigi Demo HR".
export function contextSubtitle(attrs) {
  const text = [contextTypeLabel(attrs?.contextType), sourceDescription(attrs)].filter(Boolean).join(' · ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const OTHER_CATEGORY_META = {
  label: 'Other', groupLabel: 'Other',
  description: 'No template: the context type is not one of the four templates.',
  badgeClass: 'bg-stone-100 text-stone-700 border-stone-200 dark:bg-stone-800 dark:text-stone-300 dark:border-stone-600',
};

export function categoryMeta(c) {
  return CATEGORY_META[c] || OTHER_CATEGORY_META;
}

export function variantMeta(variant) {
  return VARIANT_META[variant] || { label: variant || 'Unknown', borderClass: 'border-gray-300', dotClass: 'bg-gray-300', textClass: 'text-gray-600 dark:text-gray-400' };
}

export function targetTypeMeta(t) {
  return TARGET_TYPE_META[t] || { label: t || 'Unknown', badgeClass: 'bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600' };
}

// "Edited" treatment for a generated context an analyst has curated (renamed
// and/or re-parented). Generated nodes are normally emerald; once touched we
// tint them amber — the same hue as manual contexts — so "analyst has changed
// this" reads consistently across the tab. Returns null when there's nothing
// to mark (synced/manual nodes, or untouched generated nodes).
export function editedMeta(node) {
  if (!node || node.variant !== 'generated') return null;
  const renamed = !!node.userRenamed;
  const reparented = !!node.userReparented;
  if (!renamed && !reparented) return null;
  const parts = [];
  if (renamed) parts.push('renamed');
  if (reparented) parts.push('moved');
  return {
    label: 'Edited',
    title: `Analyst-curated (${parts.join(' + ')}) — kept when the plugin re-runs`,
    ringClass: 'ring-1 ring-amber-400 dark:ring-amber-500',
    badgeClass: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700',
  };
}
