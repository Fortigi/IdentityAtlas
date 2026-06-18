import { describe, it, expect } from 'vitest';
import { matchSlot } from './ConfigWizard.jsx';

describe('matchSlot', () => {
  it('matches an exact filename', () => {
    expect(matchSlot('Users.csv')).toBe('users');
  });

  it('is case-insensitive', () => {
    expect(matchSlot('USERS.CSV')).toBe('users');
  });

  it('tolerates separators (underscores/hyphens) in the uploaded filename', () => {
    expect(matchSlot('resource_relationships.csv')).toBe('resourceRelationships');
    expect(matchSlot('Identity-Members.csv')).toBe('identityMembers');
  });

  it('falls back to a loose substring match against the filename stem', () => {
    expect(matchSlot('MyUsers.csv')).toBe('users');
  });

  it('returns null for an unrecognized filename', () => {
    expect(matchSlot('RandomFile.txt')).toBeNull();
  });
});
