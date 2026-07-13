import { describe, it, expect } from 'vitest';
import { ALL_NAV_TABS, computeNavTabs, availableOptionalTabs } from './navTabs';

const keys = (tabs) => tabs.map(t => t.key);
const ENABLE_ALL_FEATURES = { riskScoring: true, accountLinking: true };

describe('navTabs', () => {
  it('marks Systems and Sync Log as optional', () => {
    for (const key of ['systems', 'sync-log']) {
      const tab = ALL_NAV_TABS.find(t => t.key === key);
      expect(tab, key).toBeTruthy();
      expect(tab.optional, `${key} should be optional`).toBe(true);
    }
  });

  it('hides Systems and Sync Log by default (empty visibleTabs)', () => {
    const shown = keys(computeNavTabs({ features: ENABLE_ALL_FEATURES, visibleTabs: [], canSeeAdmin: true }));
    expect(shown).not.toContain('systems');
    expect(shown).not.toContain('sync-log');
  });

  it('shows them once the user enables them', () => {
    const shown = keys(computeNavTabs({
      features: ENABLE_ALL_FEATURES,
      visibleTabs: ['systems', 'sync-log'],
      canSeeAdmin: true,
    }));
    expect(shown).toContain('systems');
    expect(shown).toContain('sync-log');
  });

  it('offers Systems and Sync Log among the toggleable optional tabs', () => {
    const optional = keys(availableOptionalTabs(ENABLE_ALL_FEATURES));
    expect(optional).toEqual(expect.arrayContaining(['systems', 'sync-log']));
  });

  it('keeps non-optional tabs visible regardless of preferences', () => {
    const shown = keys(computeNavTabs({ features: ENABLE_ALL_FEATURES, visibleTabs: [], canSeeAdmin: true }));
    expect(shown).toEqual(expect.arrayContaining(['dashboard', 'matrix', 'principals', 'resources', 'access-packages', 'contexts']));
  });

  it('does not hide optional tabs while preferences are still loading (visibleTabs null)', () => {
    const shown = keys(computeNavTabs({ features: ENABLE_ALL_FEATURES, visibleTabs: null, canSeeAdmin: true }));
    // Before prefs load we don't yet know the user's choice, so we don't remove
    // optional tabs — avoids a flash of them disappearing.
    expect(shown).toContain('systems');
    expect(shown).toContain('sync-log');
  });

  it('still gates the Admin tab on permission and feature flags', () => {
    const noAdmin = keys(computeNavTabs({ features: ENABLE_ALL_FEATURES, visibleTabs: [], canSeeAdmin: false }));
    expect(noAdmin).not.toContain('admin');

    const noRisk = keys(computeNavTabs({ features: { riskScoring: false, accountLinking: false }, visibleTabs: ['risk-scores', 'identities'], canSeeAdmin: true }));
    expect(noRisk).not.toContain('risk-scores');
    expect(noRisk).not.toContain('identities');
  });
});
