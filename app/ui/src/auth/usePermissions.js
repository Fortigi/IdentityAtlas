// Permission helper hooks. The server is the source of truth — these just
// read what /api/auth-me returned and apply boolean logic so component code
// reads like the underlying intent ("show the Excel button only if the user
// can export").
//
// Backwards-compat: until /api/auth-me responds OR when auth is disabled,
// hasWildcard=true and every check returns true. Components don't have to
// special-case "before permissions loaded."

import { useAuth } from './AuthGate';

// Pure permission check — no React, so it's safe to call inside loops/filters
// where hooks can't be used (e.g. AdminPage's tab .filter()). True if the user
// has the wildcard ('*' → "everything") or at least one of the listed
// permissions. With no `required` args it returns false; callers that treat
// "no requirement" as "always allowed" should special-case that before calling.
export function hasPermission(permissions, hasWildcard, ...required) {
  if (hasWildcard) return true;
  if (!permissions || permissions.size === 0) return false;
  return required.some(p => permissions.has(p));
}

// True if the user has at least one of the listed permissions, OR if they
// have the wildcard ('*' → "everything"). Variadic so call sites read naturally:
//   useHasPermission('data.export.ui')
//   useHasPermission('admin.crawlers', 'admin.systems')
export function useHasPermission(...required) {
  const { hasWildcard, permissions } = useAuth();
  return hasPermission(permissions, hasWildcard, ...required);
}

// Convenience helpers — give component code the verbs it cares about, with
// the catalog-permission-string mapping in one place.
export function useIsAdmin()                 { return useHasPermission('admin.auth'); }
export function useCanExportUi()             { return useHasPermission('data.export.ui'); }
export function useCanExportApiKey()         { return useHasPermission('data.export.apikey'); }
export function useCanWriteTags()            { return useHasPermission('data.write.tags'); }
export function useCanWriteCategories()      { return useHasPermission('data.write.categories'); }
export function useCanWriteRisk()            { return useHasPermission('data.write.risk'); }
export function useCanWriteCertifications()  { return useHasPermission('data.write.certifications'); }
export function useCanManageCrawlers()       { return useHasPermission('admin.crawlers'); }
export function useCanManageSystems()        { return useHasPermission('admin.systems'); }
export function useCanManageLlm()            { return useHasPermission('admin.llm'); }
export function useCanManageContextPlugins() { return useHasPermission('admin.context-plugins'); }
export function useCanCsvImport()            { return useHasPermission('admin.csv-import'); }
export function useCanManageReadTokens()     { return useHasPermission('admin.read-tokens'); }
export function useCanManageFeatureFlags()   { return useHasPermission('admin.feature-flags'); }

// Composite for the "Admin tab" gating. The tab itself is reachable if the
// user has ANY admin-tier permission — clicking individual subpages still
// gates them, but hiding the whole tab from a Servicedesk role is the right
// default UX (avoid showing controls that 403 on click).
export function useCanSeeAdminTab() {
  return useHasPermission(
    'admin.auth',
    'admin.crawlers',
    'admin.systems',
    'admin.llm',
    'admin.context-plugins',
    'admin.csv-import',
    'admin.read-tokens',
    'admin.feature-flags',
  );
}
