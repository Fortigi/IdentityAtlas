import { describe, it, expect } from 'vitest';
import { ALL_NAV_TABS, computeNavTabs, availableOptionalTabs } from './navTabs';

const keys = (tabs) => tabs.map(t => t.key);
const ENABLE_ALL_FEATURES = { riskScoring: true, accountLinking: true };
const OPT_IN = ['systems', 'identities', 'contexts', 'sync-log'];

describe('navTabs', () => {
  it('marks Systems, Identities, Contexts and Sync Log as optional', () => {
    for (const key of OPT_IN) {
      const tab = ALL_NAV_TABS.find(t => t.key === key);
      expect(tab, key).toBeTruthy();
      expect(tab.optional, `${key} should be optional`).toBe(true);
    }
  });

  it('shows Reports to everyone by default — it is not an opt-in tab', () => {
    expect(ALL_NAV_TABS.find(t => t.key === 'reports').optional).toBeFalsy();
    const shown = keys(computeNavTabs({ features: ENABLE_ALL_FEATURES, visibleTabs: [], canSeeAdmin: true }));
    expect(shown).toContain('reports');
    expect(keys(availableOptionalTabs(ENABLE_ALL_FEATURES))).not.toContain('reports');
  });

  it('hides the optional tabs by default (empty visibleTabs)', () => {
    const shown = keys(computeNavTabs({ features: ENABLE_ALL_FEATURES, visibleTabs: [], canSeeAdmin: true }));
    for (const key of OPT_IN) expect(shown, key).not.toContain(key);
  });

  it('shows them once the user enables them', () => {
    const shown = keys(computeNavTabs({ features: ENABLE_ALL_FEATURES, visibleTabs: OPT_IN, canSeeAdmin: true }));
    for (const key of OPT_IN) expect(shown, key).toContain(key);
  });

  it('enables each optional tab on its own, without dragging the others in', () => {
    const shown = keys(computeNavTabs({ features: ENABLE_ALL_FEATURES, visibleTabs: ['contexts'], canSeeAdmin: true }));
    expect(shown).toContain('contexts');
    expect(shown).not.toContain('identities');
    expect(shown).not.toContain('systems');
    expect(shown).not.toContain('sync-log');
  });

  it('offers every optional tab as a toggle while its feature is on', () => {
    const optional = keys(availableOptionalTabs(ENABLE_ALL_FEATURES));
    expect(optional.sort()).toEqual([...OPT_IN].sort());
  });

  it('needs both the feature and the opt-in for Identities', () => {
    const optedIn = { features: ENABLE_ALL_FEATURES, visibleTabs: ['identities'], canSeeAdmin: true };
    expect(keys(computeNavTabs(optedIn))).toContain('identities');

    const featureOff = { ...optedIn, features: { ...ENABLE_ALL_FEATURES, accountLinking: false } };
    expect(keys(computeNavTabs(featureOff))).not.toContain('identities');
    // No switch for a tab that could not appear anyway.
    expect(keys(availableOptionalTabs(featureOff.features))).not.toContain('identities');
    expect(keys(availableOptionalTabs(featureOff.features))).toContain('contexts');
  });

  it('surfaces Risk Scores as soon as its feature is on, with no second opt-in (H-13)', () => {
    // Feature enabled server-side but the user has never touched their tab prefs
    // (empty visibleTabs) — the tab must still show, and is not a toggle.
    const shown = keys(computeNavTabs({ features: ENABLE_ALL_FEATURES, visibleTabs: [], canSeeAdmin: true }));
    expect(shown).toContain('risk-scores');
    expect(keys(availableOptionalTabs(ENABLE_ALL_FEATURES))).not.toContain('risk-scores');
  });

  it('keeps non-optional tabs visible regardless of preferences', () => {
    const shown = keys(computeNavTabs({ features: ENABLE_ALL_FEATURES, visibleTabs: [], canSeeAdmin: true }));
    expect(shown).toEqual(['dashboard', 'matrix', 'principals', 'resources', 'access-packages', 'risk-scores', 'reports', 'admin']);
  });

  it('does not hide optional tabs while preferences are still loading (visibleTabs null)', () => {
    const shown = keys(computeNavTabs({ features: ENABLE_ALL_FEATURES, visibleTabs: null, canSeeAdmin: true }));
    // Before prefs load we don't yet know the user's choice, so we don't remove
    // optional tabs — avoids a flash of them disappearing.
    for (const key of OPT_IN) expect(shown, key).toContain(key);
  });

  it('keeps Shared matrices out of the top navigation — it lives under Admin (#1166)', () => {
    // Managing other people's share links is administration, so the top nav
    // must not carry it for anyone, permission or not.
    expect(ALL_NAV_TABS.map(t => t.key)).not.toContain('shared-matrices');
    const shown = keys(computeNavTabs({ features: ENABLE_ALL_FEATURES, visibleTabs: [], canSeeAdmin: true }));
    expect(shown).not.toContain('shared-matrices');
    expect(shown).toContain('admin');
  });

  it('still gates the Admin tab on permission and feature flags', () => {
    const noAdmin = keys(computeNavTabs({ features: ENABLE_ALL_FEATURES, visibleTabs: [], canSeeAdmin: false }));
    expect(noAdmin).not.toContain('admin');

    const noRisk = keys(computeNavTabs({ features: { riskScoring: false, accountLinking: false }, visibleTabs: ['risk-scores', 'identities'], canSeeAdmin: true }));
    expect(noRisk).not.toContain('risk-scores');
    expect(noRisk).not.toContain('identities');
  });
});
