import { describe, it, expect } from 'vitest';
import { userOf } from './userOf.js';

describe('userOf', () => {
  it.each([
    ['email first', { email: 'a@x.nl', upn: 'u', preferred_username: 'p', name: 'n' }, 'a@x.nl'],
    ['then upn', { upn: 'u@x.nl', preferred_username: 'p', name: 'n' }, 'u@x.nl'],
    ['then preferred_username', { preferred_username: 'p@x.nl', name: 'n' }, 'p@x.nl'],
    ['then name', { name: 'Jan' }, 'Jan'],
    ['unknown when every field is empty', { email: '', name: '' }, 'unknown'],
  ])('%s', (_label, user, expected) => {
    expect(userOf({ user })).toBe(expected);
  });

  it('unknown without a user', () => {
    expect(userOf({})).toBe('unknown');
    expect(userOf({ user: null })).toBe('unknown');
  });
});
