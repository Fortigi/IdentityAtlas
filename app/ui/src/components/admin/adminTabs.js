// Admin sub-tab definitions + visibility.
//
// `requires` lists permissions any one of which (logical OR) grants access to
// that sub-tab. Tabs without `requires` are visible to any authenticated user
// (read-only stuff: Performance / About).
//
// NOTE: visibility is permission-driven ONLY. It must NOT depend on the
// deployment platform — the Authentication tab hosts Roles & Permissions, so
// hiding it on (e.g.) Azure App Service would lock admins out of managing roles.
// Platform-specific guidance (the Docker CLI walkthrough) is hidden inside
// AuthSettingsPage instead, leaving Roles & Permissions reachable everywhere.

import { hasPermission } from '@ui/auth/usePermissions';

export const ADMIN_TABS = [
  { key: 'crawlers',        label: 'Crawlers',         description: 'Add, configure and run identity data crawlers',                        requires: ['admin.crawlers'] },
  { key: 'plugins',         label: 'Plugins',          description: 'Context plugins: configured trees, run, and refresh-after-crawl',      requires: ['admin.context-plugins'] },
  { key: 'automation',      label: 'Automation',       description: 'Post-crawl jobs: what runs after each crawl, in what order',           requires: ['admin.context-plugins'] },
  { key: 'account-linking', label: 'Account Linking',  description: 'Rules for linking orphan accounts to existing identities',             requires: ['admin.crawlers'] },
  { key: 'risk-scoring',    label: 'Risk Scoring',     description: 'Risk profile, classifiers and feature toggle',                         requires: ['admin.llm', 'admin.crawlers'] },
  { key: 'llm',             label: 'LLM Settings',     description: 'Configure the LLM provider used by risk scoring',                      requires: ['admin.llm'] },
  { key: 'performance',     label: 'Performance',      description: 'API and SQL performance metrics' },

  { key: 'auth',            label: 'Authentication',   description: 'Single sign-on and role / permission management',                      requires: ['admin.auth'] },
  { key: 'data',            label: 'Data',             description: 'Export/import curated data and clean the database',                    requires: ['data.export.ui', 'admin.csv-import', 'admin.systems', 'admin.read-tokens', 'data.export.apikey'] },
  { key: 'about',           label: 'About',            description: 'License, version, and software bill of materials' },
];

// Filter the admin sub-tabs to the ones the current user may use.
export function visibleAdminTabs(permissions, hasWildcard, tabs = ADMIN_TABS) {
  return tabs.filter(t => !t.requires || hasPermission(permissions, hasWildcard, ...t.requires));
}
