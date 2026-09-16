// @vitest-environment jsdom
//
// The UI's client-side permission gate. Nothing tested it directly before this
// file: seven components import it, and its coverage came entirely from whatever
// those components happened to render, which is why it sat at 39%.
//
// It decides what a user is shown, not what they may do — the API is the real
// authority. But "hide controls that would 403 on click" is the whole contract,
// and getting it wrong in the permissive direction shows a Servicedesk user
// buttons that fail, while getting it wrong in the restrictive direction hides
// the Admin tab from someone who has admin rights. Both are worth pinning.
//
// Input choice matters more than case count here. Two rules used throughout:
//   * to prove the WILDCARD branch fires, the permission set must NOT contain
//     the permission being asked for — otherwise the final `.some()` would
//     return true as well and the assertion proves nothing;
//   * to prove a hook is wired to the RIGHT permission string, it must be
//     checked against a set holding some OTHER permission, not just against its
//     own. A hook that ignored its argument entirely passes the positive half.
import { describe, it, expect } from 'vitest';
import {
  hasPermission,
  useHasPermission,
  useIsAdmin,
  useCanExportUi,
  useCanExportApiKey,
  useCanWriteTags,
  useCanWriteCategories,
  useCanWriteRisk,
  useCanWriteCertifications,
  useCanManageCrawlers,
  useCanManageSystems,
  useCanManageLlm,
  useCanManageContextPlugins,
  useCanCsvImport,
  useCanManageReadTokens,
  useCanManageFeatureFlags,
  useCanSeeAdminTab,
} from '@ui/auth/usePermissions';
import { makeWrapper, renderHook } from '@ui/test-utils/renderWithProviders';

// Render one hook against an explicit permission state.
function callHook(hook, { permissions = null, hasWildcard = false } = {}) {
  const { wrapper } = makeWrapper({
    auth: { permissions, hasWildcard, permissionsLoaded: true },
  });
  return renderHook(() => hook(), { wrapper }).result.current;
}

describe('hasPermission', () => {
  it('grants everything to the wildcard holder, including permissions absent from their set', () => {
    // The set deliberately does NOT contain 'admin.auth'. If it did, the final
    // `.some()` would also return true and this would pass even with the
    // wildcard branch removed.
    expect(hasPermission(new Set(['data.export.ui']), true, 'admin.auth')).toBe(true);
  });

  it('grants to the wildcard holder even with no permission set at all', () => {
    expect(hasPermission(null, true, 'admin.auth')).toBe(true);
  });

  it('denies when the user holds a different permission than the one asked for', () => {
    // Non-empty set, wrong contents. This is the case that separates "checks
    // the set" from "returns true whenever the set is non-empty".
    expect(hasPermission(new Set(['data.export.ui']), false, 'admin.auth')).toBe(false);
  });

  it('grants when the user holds exactly the permission asked for', () => {
    expect(hasPermission(new Set(['admin.auth']), false, 'admin.auth')).toBe(true);
  });

  it('grants when the user holds ANY ONE of several accepted permissions', () => {
    // The composite-gate case: eight permissions accepted, user has one. If the
    // check required all of them, every non-superuser would lose the Admin tab.
    const perms = new Set(['admin.crawlers']);
    expect(hasPermission(perms, false, 'admin.auth', 'admin.crawlers', 'admin.systems')).toBe(true);
  });

  it('denies when the user holds none of several accepted permissions', () => {
    const perms = new Set(['data.write.tags']);
    expect(hasPermission(perms, false, 'admin.auth', 'admin.crawlers', 'admin.systems')).toBe(false);
  });

  it('denies — without throwing — when permissions have not loaded yet', () => {
    // `!permissions || permissions.size === 0`. Read as `&&`, this reaches
    // `null.size` and throws a TypeError instead of returning a decision,
    // taking down every component that asked.
    expect(() => hasPermission(null, false, 'admin.auth')).not.toThrow();
    expect(hasPermission(null, false, 'admin.auth')).toBe(false);
    expect(hasPermission(undefined, false, 'admin.auth')).toBe(false);
  });

  it('denies for an authenticated user with an empty permission set', () => {
    expect(hasPermission(new Set(), false, 'admin.auth')).toBe(false);
  });

  it('denies when no permission is named, rather than treating it as "unrestricted"', () => {
    // Documented behaviour: callers that mean "no requirement = allow" must say
    // so themselves. The dangerous reading is the opposite one.
    expect(hasPermission(new Set(['admin.auth']), false)).toBe(false);
  });
});

describe('useHasPermission', () => {
  it('reads the permission state out of auth context', () => {
    expect(callHook(() => useHasPermission('admin.auth'), { permissions: new Set(['admin.auth']) })).toBe(true);
    expect(callHook(() => useHasPermission('admin.auth'), { permissions: new Set(['other']) })).toBe(false);
  });

  it('returns true before /api/auth-me responds, so the UI renders normally', () => {
    // Pre-load and auth-disabled both present as hasWildcard=true with a null
    // set — the backwards-compat contract in AuthGate's default context.
    expect(callHook(() => useHasPermission('admin.auth'), { permissions: null, hasWildcard: true })).toBe(true);
  });
});

describe('permission-to-verb mapping', () => {
  // Each convenience hook exists to put one catalog string in one place. The
  // failure worth catching is a hook wired to the WRONG string — which grants
  // on the strength of an unrelated permission the user does happen to hold.
  const cases = [
    ['useIsAdmin', useIsAdmin, 'admin.auth'],
    ['useCanExportUi', useCanExportUi, 'data.export.ui'],
    ['useCanExportApiKey', useCanExportApiKey, 'data.export.apikey'],
    ['useCanWriteTags', useCanWriteTags, 'data.write.tags'],
    ['useCanWriteCategories', useCanWriteCategories, 'data.write.categories'],
    ['useCanWriteRisk', useCanWriteRisk, 'data.write.risk'],
    ['useCanWriteCertifications', useCanWriteCertifications, 'data.write.certifications'],
    ['useCanManageCrawlers', useCanManageCrawlers, 'admin.crawlers'],
    ['useCanManageSystems', useCanManageSystems, 'admin.systems'],
    ['useCanManageLlm', useCanManageLlm, 'admin.llm'],
    ['useCanManageContextPlugins', useCanManageContextPlugins, 'admin.context-plugins'],
    ['useCanCsvImport', useCanCsvImport, 'admin.csv-import'],
    ['useCanManageReadTokens', useCanManageReadTokens, 'admin.read-tokens'],
    ['useCanManageFeatureFlags', useCanManageFeatureFlags, 'admin.feature-flags'],
  ];

  it.each(cases)('%s grants on %s and on nothing else', (_name, hook, permission) => {
    expect(callHook(hook, { permissions: new Set([permission]) })).toBe(true);

    // Every OTHER permission in the catalog must leave this hook closed.
    const others = cases.map(c => c[2]).filter(p => p !== permission);
    expect(callHook(hook, { permissions: new Set(others) })).toBe(false);
  });
});

describe('useCanSeeAdminTab', () => {
  const adminTier = [
    'admin.auth',
    'admin.crawlers',
    'admin.systems',
    'admin.llm',
    'admin.context-plugins',
    'admin.csv-import',
    'admin.read-tokens',
    'admin.feature-flags',
  ];

  it.each(adminTier)('opens the tab for a user whose only admin permission is %s', (permission) => {
    expect(callHook(useCanSeeAdminTab, { permissions: new Set([permission]) })).toBe(true);
  });

  it('keeps the tab closed for a user with data permissions but no admin tier', () => {
    const dataOnly = new Set([
      'data.export.ui',
      'data.export.apikey',
      'data.write.tags',
      'data.write.categories',
      'data.write.risk',
      'data.write.certifications',
    ]);
    expect(callHook(useCanSeeAdminTab, { permissions: dataOnly })).toBe(false);
  });
});
