import { describe, it, expect } from 'vitest';
import { OPTIONAL_TABS } from './preferences.js';

// The preferences route filters a user's saved visibleTabs against this
// allowlist on both read and write — a tab key not in the list can never be
// persisted as "enabled". It must stay in sync with the `optional` tabs in the
// UI's utils/navTabs.js, or a user could toggle a tab on but never have it stick.
describe('preferences OPTIONAL_TABS allowlist', () => {
  it('lets users enable the Systems and Sync Log tabs', () => {
    expect(OPTIONAL_TABS).toEqual(expect.arrayContaining(['systems', 'sync-log']));
  });

  it('keeps the previously-optional tabs enable-able', () => {
    expect(OPTIONAL_TABS).toEqual(expect.arrayContaining(['risk-scores', 'identities', 'performance', 'admin']));
  });
});
