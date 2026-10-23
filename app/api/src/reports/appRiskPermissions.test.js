// The permission tier the risky-applications score stands on. The cases that
// matter are the ones where the two underlying lists disagree, or where a name
// must NOT be trusted: the same value on another API, or the same value held
// delegated instead of app-only.

import { describe, it, expect } from 'vitest';
import { permissionTier, highestTier, atLeast, MICROSOFT_API_APP_IDS } from './appRiskPermissions.js';

const GRAPH = '00000003-0000-0000-c000-000000000000';
const EXCHANGE = '00000002-0000-0ff1-ce00-000000000000';
const THIRD_PARTY = '11111111-2222-3333-4444-555555555555';

describe('permissionTier', () => {
  it('takes the explicit shortlist for an app-only permission on a Microsoft API', () => {
    expect(permissionTier({ kind: 'application', apiAppId: GRAPH, permission: 'Mail.ReadWrite' })).toBe('Critical');
    // The name list calls Mail.Read only Medium; app-only it reads every mailbox.
    expect(permissionTier({ kind: 'application', apiAppId: GRAPH, permission: 'Mail.Read' })).toBe('High');
    expect(permissionTier({ kind: 'application', apiAppId: EXCHANGE, permission: 'full_access_as_app' })).toBe('Critical');
  });

  it('uses the name tiering for a delegated scope, even when the app-only list names the same value', () => {
    // Delegated Mail.Read reads the signed-in user's own mailbox, not every mailbox.
    expect(permissionTier({ kind: 'delegated', apiAppId: GRAPH, permission: 'Mail.Read' })).toBe('Medium');
    expect(permissionTier({ kind: 'delegated', apiAppId: GRAPH, permission: 'Mail.Send' })).toBe('High');
    expect(permissionTier({ kind: 'delegated', apiAppId: GRAPH, permission: 'User.Read' })).toBe('Low');
  });

  it('falls back to the name tiering for an app-only permission the shortlist does not name', () => {
    expect(permissionTier({ kind: 'application', apiAppId: GRAPH, permission: 'Group.ReadWrite.All' })).toBe('High');
    expect(permissionTier({ kind: 'application', apiAppId: GRAPH, permission: 'Calendars.Read.All' })).toBe('Medium');
  });

  it('never trusts a name on an API it does not recognise', () => {
    expect(permissionTier({ kind: 'application', apiAppId: THIRD_PARTY, permission: 'Mail.ReadWrite' })).toBe('Unknown');
    expect(permissionTier({ kind: 'delegated', apiAppId: THIRD_PARTY, permission: 'Directory.ReadWrite.All' })).toBe('Unknown');
    expect(permissionTier({ kind: 'delegated', apiAppId: null, permission: 'Mail.Send' })).toBe('Unknown');
  });

  it('matches the API appId case-insensitively and calls a missing permission Unknown', () => {
    expect(permissionTier({ kind: 'delegated', apiAppId: GRAPH.toUpperCase(), permission: 'Mail.Send' })).toBe('High');
    expect(permissionTier({ kind: 'application', apiAppId: GRAPH, permission: '' })).toBe('Unknown');
  });

  it('knows exactly the four Microsoft APIs', () => {
    expect(MICROSOFT_API_APP_IDS.size).toBe(4);
    expect(MICROSOFT_API_APP_IDS.has(GRAPH)).toBe(true);
  });
});

describe('highestTier / atLeast', () => {
  it('picks the highest tier regardless of order, and ignores values that are not tiers', () => {
    expect(highestTier(['Low', 'High', 'Medium'])).toBe('High');
    expect(highestTier(['Medium', 'Critical'])).toBe('Critical');
    expect(highestTier(['Unknown', 'Low'])).toBe('Low');
    expect(highestTier(['bogus'])).toBe('Unknown');
    expect(highestTier([])).toBe('Unknown');
  });

  it('compares tiers inclusively, with Unknown below Low', () => {
    expect(atLeast('Critical', 'High')).toBe(true);
    expect(atLeast('High', 'High')).toBe(true);
    expect(atLeast('Medium', 'High')).toBe(false);
    expect(atLeast('Unknown', 'Low')).toBe(false);
    expect(atLeast('bogus', 'Low')).toBe(false);
    expect(atLeast('High', 'bogus')).toBe(false);
  });
});
