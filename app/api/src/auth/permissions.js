// Permission catalog — fixed in code, mapped to Entra app-role names at
// runtime via the WorkerConfig key AUTH_ROLE_PERMISSIONS (see authConfig.js).
//
// Adding to this list is safe: roles whose mapping uses '*' immediately
// inherit the new permission; roles with explicit permission lists do not.
// Removing or renaming a permission is a BREAKING change for any customer
// whose saved mapping references it — avoid.

export const PERMISSIONS = Object.freeze({
  'data.read':                 { label: 'Read all data',           group: 'Read',
    description: "View matrix, dashboards, detail pages, governance reads. Effectively 'can sign in at all.'" },

  'data.export.ui':            { label: 'Export to Excel/CSV',     group: 'Export',
    description: 'Show Excel / CSV export buttons in the UI and allow calls to /api/data-export/*.' },
  'data.export.apikey':        { label: 'Generate read-only API keys', group: 'Export',
    description: 'Mint fgr_ tokens for PowerQuery / BI tools to pull data on a schedule.' },

  'data.write.tags':           { label: 'Manage tags',             group: 'Write',
    description: 'Create, edit, delete tags and apply them to entities.' },
  'data.write.categories':     { label: 'Manage categories',       group: 'Write',
    description: 'Create, edit, delete categories and assign them to access packages.' },
  'data.write.risk':           { label: 'Risk score overrides',    group: 'Write',
    description: 'Override analyst-decidable risk scores on identities and resources.' },
  'data.write.certifications': { label: 'Certification decisions', group: 'Write',
    description: 'Approve, revoke, or comment on certification decisions.' },

  'admin.crawlers':            { label: 'Crawler configuration',   group: 'Admin',
    description: 'Create / edit / run crawlers, manage crawler API keys and schedules.' },
  'admin.systems':             { label: 'Systems configuration',   group: 'Admin',
    description: 'Add, edit, remove connected systems and assign owners.' },
  'admin.llm':                 { label: 'LLM configuration',       group: 'Admin',
    description: 'Configure the LLM provider and model used for risk scoring.' },
  'admin.context-plugins':     { label: 'Context plugins',         group: 'Admin',
    description: 'Run and configure context-algorithm plugins (clustering, manager-hierarchy, etc.).' },
  'admin.csv-import':          { label: 'CSV import',              group: 'Admin',
    description: 'Upload CSV files and run custom-connector ingest jobs.' },
  'admin.read-tokens':         { label: 'Manage read API keys',    group: 'Admin',
    description: 'List and revoke existing fgr_ read tokens that other people minted.' },
  'admin.feature-flags':       { label: 'Feature flags',           group: 'Admin',
    description: 'Toggle FEATURE_* flags (risk scoring, account correlation, etc.).' },
  'admin.auth':                { label: 'Authentication & roles',  group: 'Admin',
    description: 'Edit role → permission mapping (this very page). Required to avoid locking yourself out.' },
});

export const PERMISSION_GROUPS = Object.freeze(['Read', 'Export', 'Write', 'Admin']);

// Default mapping shipped on a fresh install. The customer can edit any of
// this in the Admin UI; we never overwrite their saved mapping. '*' is a
// wildcard that grants every permission in the catalog (including future
// additions) — used for Admin so adding a permission to PERMISSIONS doesn't
// silently demote the admin role.
export const SEED_ROLE_PERMISSIONS = Object.freeze({
  Admin:       ['*'],
  RoleMiner:   ['data.read', 'data.export.ui', 'data.export.apikey'],
  Servicedesk: ['data.read'],
});

const ALL_PERMISSION_KEYS = Object.freeze(Object.keys(PERMISSIONS));

export function isKnownPermission(key) {
  return key === '*' || Object.prototype.hasOwnProperty.call(PERMISSIONS, key);
}

// Resolve a token's roles to a Set of permission strings.
// Wildcards expand to every known permission key (so '*' membership and
// 'admin.auth' membership both work for downstream checks).
export function resolvePermissions(tokenRoles, mapping) {
  const out = new Set();
  if (!Array.isArray(tokenRoles)) return out;
  for (const role of tokenRoles) {
    const granted = mapping?.[role];
    if (!Array.isArray(granted)) continue;
    for (const p of granted) {
      if (p === '*') {
        out.add('*');
        for (const k of ALL_PERMISSION_KEYS) out.add(k);
      } else if (isKnownPermission(p)) {
        out.add(p);
      }
    }
  }
  return out;
}
