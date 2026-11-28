// Every table the migrations create, with what made its rows.
//
// The rule behind Admin → Data → Clean database (decided 2026-11): a clean
// removes everything a crawler or plugin can recreate, and nothing a person
// made. A person-made row that structurally cannot exist without the crawled
// row it hangs on (a foreign key with ON DELETE CASCADE) goes with it, and the
// confirmation dialog names it — that is ALSO_REMOVED below.
//
// Labels (exactly one per table):
//   crawler  — written by a crawler or the ingest; the next sync writes it again
//   derived  — computed from crawler data by a plugin, a run or a scheduler
//   curated  — made by a person in the UI or the API
//   config   — settings a person chose
//   audit    — a record of what happened; kept
//   secret   — keys and secrets; kept
//
// crawler and derived tables are removed; the other four are kept. A table that
// holds both kinds of row has a `removeWhere` predicate: only the rows it
// matches are deleted (for a kept table), or only they are (for a removed one).
// Every predicate is a static SQL literal — no input ever reaches one.
//
// Adding a migration that creates a table? Add it here. The guard test
// (tableClassification.guard.test.js) fails until you do, and the contract test
// (contract-tests/cleanDatabase.contract.test.js) fails until you seed a row for
// it and say whether a clean keeps it.
//
// Order matters: removed tables are deleted in the order listed, children
// before parents, so each DELETE reports its own rows.

import { UPLOAD_SYSTEM_TYPE } from '../contexts/upload/lists.js';

export const LABELS = Object.freeze(['crawler', 'derived', 'curated', 'config', 'audit', 'secret']);
export const REMOVED_LABELS = Object.freeze(new Set(['crawler', 'derived']));

// An uploaded list is a System of type 'Upload' (contexts/upload/lists.js). A
// person uploaded it; no crawler can bring it back, so it and its contexts stay.
const KEPT_SYSTEMS = `SELECT id FROM "Systems" WHERE "systemType" = '${UPLOAD_SYSTEM_TYPE}'`;

// ─── What the dialog shows, as groups ─────────────────────────────────────────
export const GROUPS = Object.freeze({
  source: 'Systems, accounts, resources and access loaded by your crawlers',
  identities: 'Identities and the accounts linked to them',
  governance: 'Governance data from your sources: catalogs, business roles, policies, requests and review decisions',
  contexts: 'Synced and generated contexts (org charts, departments, clusters and other plugin trees) with their members',
  computed: 'Computed results: risk scores, dashboard trend snapshots, and the run history of plugins, risk scoring and account linking',
  jobs: 'Crawler job history, the sync log and saved delta tokens, so the next crawl is a full one',
  historyRemoved: 'The change history of everything removed',

  settings: 'Settings: crawler configurations and registrations, feature flags, role mapping, LLM, history retention and personal preferences',
  riskRules: 'Risk profiles, risk classifiers and account-linking rules',
  secrets: 'Stored secrets and read-API keys',
  manual: 'Manual contexts and tags, with the members you added',
  uploads: 'Uploaded lists, with their contexts, members and the owners you assigned to them',
  saved: 'Saved matrix views, matrix shares, saved reports and report views',
  categories: 'Business-role categories and their assignments',
  judgements: 'Interviews, claims, decisions, change requests, tree adjustments, workbench investigations and role proposals on contexts that are kept',
  overrides: 'Analyst risk-score overrides',
  audit: 'Audit logs: role changes, crawler audit, MCP tool calls, share access, update checks and bot conversations',
  historyKept: 'The change history of everything kept',
});

const t = (table, label, group, reason, extra = {}) => Object.freeze({ table, label, group, reason, ...extra });

export const TABLE_CLASSIFICATION = Object.freeze([
  // ── Removed: crawler data, children first ───────────────────────────────────
  t('ResourceAssignments', 'crawler', 'source', 'Who has access to what, as the sources report it.'),
  t('ResourceRelationships', 'crawler', 'source', 'Resource-to-resource links from the sources.'),
  t('PrincipalRelationships', 'crawler', 'source', 'Owner / sponsor links between accounts, from the sources.'),
  t('PrincipalActivity', 'crawler', 'source', 'Latest sign-in activity per account, rewritten by every crawl.'),
  t('CertificationDecisions', 'crawler', 'governance', 'Access-review decisions read from the IGA source.'),
  t('AssignmentRequests', 'crawler', 'governance', 'Access-package requests read from the IGA source.'),
  t('AssignmentPolicies', 'crawler', 'governance', 'Assignment policies read from the IGA source.'),
  t('IdentityMembers', 'crawler', 'identities',
    'Account-to-identity links. Rows with an analystOverride are a person\'s decision, but they cannot outlive their Identity (FK CASCADE), so they go — see ALSO_REMOVED.'),
  t('Identities', 'crawler', 'identities',
    'Persons from an HR / identity feed. analystVerified and analystNotes on a row go with it — see ALSO_REMOVED.'),
  t('ContextMembers', 'crawler', 'contexts',
    'Mixed, by addedBy. Rows a plugin added (algorithm) go everywhere; on a removed context every member goes with it (FK CASCADE). On a kept context the other rows stay: an analyst added them, or they came from the person\'s uploaded list. memberId has no FK, so a kept member of an account that is removed comes back when the crawl brings the same id back (Entra object ids and deterministic ingest ids are stable).',
    { removeWhere: `"addedBy" = 'algorithm'` }),
  t('ContextRelationships', 'crawler', 'contexts',
    'Mixed, by addedBy. Plugin rows go; a link involving a removed context goes with it (FK CASCADE); an analyst\'s link between two kept contexts stays.',
    { removeWhere: `"addedBy" = 'algorithm'` }),
  t('ContextRoles', 'crawler', 'contexts',
    'Mixed, by addedBy. sync / sourceOwner / algorithm rows are recreated by the next crawl or plugin run. Analyst rows are a person\'s, but every holder is a Principal or an Identity (FK CASCADE), all of which are removed — so they go too; see ALSO_REMOVED.',
    { removeWhere: `"addedBy" <> 'analyst'` }),
  t('BusinessRoleOwners', 'crawler', 'governance',
    'Mixed, by addedBy. sync / import rows go. Analyst rows are a person\'s, but each hangs on a business role and a holder (FK CASCADE), all of which are removed — so they go too; see ALSO_REMOVED.',
    { removeWhere: `"addedBy" <> 'analyst'` }),
  t('Contexts', 'crawler', 'contexts',
    'Mixed, by variant. generated (a plugin) and synced (a crawler) contexts go; manual ones stay, and so do the synced contexts of an uploaded list. A kept context whose parent is removed moves to the top level.',
    { removeWhere: `variant <> 'manual' AND NOT (variant = 'synced' AND COALESCE("scopeSystemId" IN (${KEPT_SYSTEMS}), false))`, keptGroup: 'manual' }),
  t('Resources', 'crawler', 'source', 'Groups, roles, apps, business roles — everything that grants access.'),
  t('Principals', 'crawler', 'source', 'Accounts from every source.'),
  t('DeltaTokens', 'crawler', 'jobs', 'Graph delta tokens; without the data they described they must go, or the next crawl would fetch only changes.'),
  t('GraphSyncLog', 'crawler', 'jobs', 'The sync log of crawls whose data is removed.'),
  t('CrawlerJobs', 'crawler', 'jobs', 'Crawler job history and its progress output.'),
  t('Systems', 'crawler', 'source',
    'Mixed, by systemType. Crawled systems go. An uploaded list (systemType Upload) was made by a person, so it stays with its contexts and runs.',
    { removeWhere: `"systemType" IS DISTINCT FROM '${UPLOAD_SYSTEM_TYPE}'`, keptGroup: 'uploads' }),

  // ── Removed: derived ────────────────────────────────────────────────────────
  t('RiskScores', 'derived', 'computed',
    'Mixed. Computed scores go; a row with an analyst riskOverride stays (it is keyed on the entity id, no FK) and applies again when the entity returns.',
    { removeWhere: `"riskOverride" IS NULL`, keptGroup: 'overrides' }),
  t('ContextAlgorithmRuns', 'derived', 'computed', 'Run history of the context plugins.'),
  t('ScoringRuns', 'derived', 'computed', 'Run history of risk scoring.'),
  t('AccountLinkingRuns', 'derived', 'computed', 'Run history of account linking.'),
  t('DashboardSnapshots', 'derived', 'computed', 'Daily dashboard counts of the data being removed; the trend would otherwise show it.'),

  // ── Kept: settings ──────────────────────────────────────────────────────────
  t('WorkerConfig', 'config', 'settings',
    'Mixed, by configKey. Settings (role mapping, feature flags, LLM_CONFIG, history retention, …) stay. Crawl state goes: matrixViews.lastProbeRebuildAt is removed and syncVersion is advanced, so no cache serves removed data.',
    { removeWhere: `"configKey" IN ('matrixViews.lastProbeRebuildAt')` }),
  t('CrawlerConfigs', 'config', 'settings', 'Crawler configurations. Kept, with lastRunAt / lastRunStatus reset to "never run".'),
  t('Crawlers', 'config', 'settings', 'Registered crawlers and their hashed API keys.'),
  t('ContextAlgorithms', 'config', 'settings', 'The context-plugin registry and whether each plugin is enabled.'),
  t('GraphUserPreferences', 'config', 'settings', 'Per-user UI preferences.'),
  t('RiskProfiles', 'config', 'riskRules', 'Risk profiles.'),
  t('RiskClassifiers', 'config', 'riskRules', 'Risk classifiers.'),
  t('GraphRiskProfiles', 'config', 'riskRules', 'Legacy risk profiles.'),
  t('GraphRiskClassifiers', 'config', 'riskRules', 'Legacy risk classifiers.'),
  t('AccountLinkingConfig', 'config', 'riskRules', 'Account-linking rules.'),

  // ── Kept: secrets ───────────────────────────────────────────────────────────
  t('Secrets', 'secret', 'secrets', 'Encrypted secrets (crawler credentials).'),
  t('ReadApiKeys', 'secret', 'secrets', 'Read-API keys.'),

  // ── Kept: curated ───────────────────────────────────────────────────────────
  t('SavedMatrixFilters', 'curated', 'saved', 'Saved matrix views.'),
  t('MatrixShares', 'curated', 'saved', 'Matrix shares.'),
  t('MatrixShareRecipients', 'curated', 'saved', 'Who a matrix share is shared with.'),
  t('SavedReports', 'curated', 'saved', 'Saved reports.'),
  t('ReportViews', 'curated', 'saved', 'Saved report views.'),
  t('GovernanceCategories', 'curated', 'categories', 'Business-role categories.'),
  t('GovernanceCategoryAssignments', 'curated', 'categories', 'Category assignments; resourceId has no FK, so they reattach when the business role returns.'),
  t('SystemOwners', 'curated', 'uploads', 'Owners a person assigned to a system. FK CASCADE to Systems: owners of a removed system go — see ALSO_REMOVED.'),
  t('ManagerHierarchyOverrides', 'curated', null, 'Org-chart manager overrides. FK CASCADE to Principals, all removed — see ALSO_REMOVED.'),
  t('ContextRoleSuggestionRejections', 'curated', null, 'Rejected Accountable suggestions. FK CASCADE to the Principal / Identity they name, all removed — see ALSO_REMOVED.'),
  t('BusinessRoleCompositionReviews', 'curated', null, 'Composition reviews of a business role, with notes and who saved them. FK CASCADE to the role, all removed — see ALSO_REMOVED.'),
  t('BusinessRoleCompositionReviewSteps', 'curated', null, 'The verdict per step of a composition review, with the remark and any proposed owners. FK CASCADE to the review, all removed — see ALSO_REMOVED.'),
  t('BusinessRoleOwnerRejections', 'curated', null, 'Rejected owner suggestions on a business role. FK CASCADE to the role and the Principal they name, all removed — see ALSO_REMOVED.'),
  t('ContextUploads', 'curated', 'uploads', 'The runs of an uploaded list. Its system is always an uploaded list, which is kept.',
    { cascadeSafe: 'systemId always points at an Upload system, and those are kept.' }),
  t('ContextInterviews', 'curated', 'judgements', 'Uploaded interviews. Kept on a kept context; the link to a removed account is cleared, the interviewee name stays.'),
  t('ContextClaims', 'curated', 'judgements', 'Claims from interviews. Kept on a kept context; the link to a removed account or context is cleared.'),
  t('ContextMemberOverrides', 'curated', 'judgements', '"Marked former" decisions. Kept on a kept context.'),
  t('ChangeRequests', 'curated', 'judgements', 'Change requests. Always kept; the link to a removed system, context, claim or override is cleared, the names stay.'),
  t('ContextTreeAdjustments', 'curated', 'judgements', 'Tree adjustments. Kept for a generated or hand-built tree; one on a crawled tree (scopeSystemId) goes with its system — see ALSO_REMOVED.'),
  t('WorkbenchInvestigations', 'curated', 'judgements', 'Workbench investigations. Kept on a kept context.'),
  t('WorkbenchAccessSnapshots', 'curated', 'judgements', 'The access an investigation saw, kept with it.'),
  t('WorkbenchMarks', 'curated', 'judgements', 'Marks in an investigation, kept with it.'),
  t('RoleProposals', 'curated', 'judgements', 'Role proposals. Kept with their investigation; the link to a removed base business role is cleared.'),
  t('RoleProposalMembers', 'curated', 'judgements', 'Proposal members (no FK to the person), kept with the proposal.'),
  t('RoleProposalEntitlements', 'curated', 'judgements', 'Proposal entitlements (no FK to the resource), kept with the proposal.'),
  t('RoleProposalEvidence', 'curated', 'judgements', 'Claims a proposal rests on, kept while both are.'),

  // ── Kept: audit ─────────────────────────────────────────────────────────────
  t('AuthRoleChangeLog', 'audit', 'audit', 'Role-mapping changes.'),
  t('CrawlerAuditLog', 'audit', 'audit', 'What registered crawlers did.'),
  t('McpToolCalls', 'audit', 'audit', 'MCP tool calls.'),
  t('MatrixShareAccesses', 'audit', 'audit', 'Who opened a matrix share.'),
  t('UpdateLog', 'audit', 'audit', 'Update checks and applied updates.'),
  t('ComponentVersions', 'audit', 'audit', 'Last-seen version of each component.'),
  t('BotConversations', 'audit', 'audit', 'Teams bot conversation log.'),
  t('_history', 'audit', 'historyKept',
    'Mixed. The history of every removed row goes (all of it for a table removed whole, the rows deleted by the clean for the others); the history of what is kept stays.',
    { removedGroup: 'historyRemoved' }),
]);

// group null: a kept table no row of which can survive a clean (every row hangs
// on removed data). It is shown only under ALSO_REMOVED.
//
// Person-made work that goes because it hangs on removed data. Named in the
// dialog. Each table here is a kept table a foreign-key cascade can reach.
export const ALSO_REMOVED = Object.freeze([
  { what: 'Owners you assigned to a crawled system', because: 'the system is removed', tables: ['SystemOwners'] },
  { what: 'Manager overrides in the org chart', because: 'the account they move is removed', tables: ['ManagerHierarchyOverrides'] },
  { what: 'Accountable and Responsible people on contexts, including the ones you set, and rejected suggestions', because: 'every holder is an account or an identity, and those are removed', tables: ['ContextRoles', 'ContextRoleSuggestionRejections'] },
  { what: 'Accountable and Responsible people on business roles, including the ones you set, and rejected suggestions', because: 'the business roles and their holders are removed', tables: ['BusinessRoleOwners', 'BusinessRoleOwnerRejections'] },
  { what: 'Composition reviews of business roles, with their verdicts, remarks and notes', because: 'the business roles are removed', tables: ['BusinessRoleCompositionReviews', 'BusinessRoleCompositionReviewSteps'] },
  { what: 'Your confirm, reject and move decisions on identity accounts, and analyst verification and notes on identities', because: 'the identities they belong to are removed', tables: ['IdentityMembers', 'Identities'] },
  { what: 'Members and links you added to a synced or generated context', because: 'that context is removed', tables: ['ContextMembers', 'ContextRelationships'] },
  {
    what: 'Interviews, claims, decisions and workbench investigations (with their role proposals) on a synced or generated context',
    because: 'that context is removed',
    tables: ['ContextInterviews', 'ContextClaims', 'ContextMemberOverrides', 'WorkbenchInvestigations', 'WorkbenchAccessSnapshots', 'WorkbenchMarks', 'RoleProposals', 'RoleProposalMembers', 'RoleProposalEntitlements', 'RoleProposalEvidence'],
  },
  { what: 'Tree adjustments on a tree tied to a crawled system', because: 'that system is removed', tables: ['ContextTreeAdjustments'] },
]);

// Kept, but changed.
export const KEPT_BUT_CHANGED = Object.freeze([
  { what: 'A manual context placed under a synced or generated context moves to the top level', tables: ['Contexts'] },
  { what: 'Kept interviews, claims and change requests lose their link to a removed account, context or system; the names they recorded stay', tables: ['ContextInterviews', 'ContextClaims', 'ChangeRequests'] },
  { what: 'A role proposal that extends a removed business role loses that link', tables: ['RoleProposals'] },
  { what: 'Crawler configurations show as never run', tables: ['CrawlerConfigs'] },
]);

export const isRemovedLabel = (label) => REMOVED_LABELS.has(label);

/** The classification of one table, or undefined. */
export function classificationOf(table) {
  return TABLE_CLASSIFICATION.find(e => e.table === table);
}

const uniq = (xs) => [...new Set(xs)];

/**
 * What a clean does, for the confirmation dialog — built from the
 * classification, so the dialog cannot say something the clean does not do.
 */
export function cleanDatabasePlan() {
  const removedKeys = uniq(TABLE_CLASSIFICATION.flatMap(e => {
    if (isRemovedLabel(e.label)) return [e.group];
    return e.removedGroup ? [e.removedGroup] : [];
  }));
  const keptKeys = uniq(TABLE_CLASSIFICATION.flatMap(e => {
    if (!isRemovedLabel(e.label)) return e.group ? [e.group] : [];
    return e.keptGroup ? [e.keptGroup] : [];
  }));
  const tablesOf = (key) => TABLE_CLASSIFICATION
    .filter(e => e.group === key || e.keptGroup === key || e.removedGroup === key)
    .map(e => e.table);
  return {
    removed: removedKeys.map(key => ({ key, text: GROUPS[key], tables: tablesOf(key) })),
    kept: keptKeys.map(key => ({ key, text: GROUPS[key], tables: tablesOf(key) })),
    alsoRemoved: ALSO_REMOVED.map(a => ({ ...a })),
    keptButChanged: KEPT_BUT_CHANGED.map(a => ({ ...a })),
  };
}
