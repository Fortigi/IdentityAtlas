import { describe, it, expect } from 'vitest';
import { buildAuthHeaders } from './authFetchHeaders';

describe('buildAuthHeaders', () => {
  it('marks every request as coming from the app, even with no token', () => {
    expect(buildAuthHeaders(undefined, null)).toEqual({ 'X-Requested-With': 'IdentityAtlas' });
  });

  it('adds the bearer token and keeps caller headers', () => {
    expect(buildAuthHeaders({ 'Content-Type': 'application/json' }, 'tok-1')).toEqual({
      'X-Requested-With': 'IdentityAtlas',
      'Content-Type': 'application/json',
      Authorization: 'Bearer tok-1',
    });
  });

  it('never lets a caller header override the signed-in token', () => {
    expect(buildAuthHeaders({ Authorization: 'Bearer stale' }, 'fresh').Authorization).toBe('Bearer fresh');
  });

  it('does not mutate the caller-supplied headers object', () => {
    const caller = { Accept: 'text/csv' };
    buildAuthHeaders(caller, 'tok');
    expect(caller).toEqual({ Accept: 'text/csv' });
  });
});
