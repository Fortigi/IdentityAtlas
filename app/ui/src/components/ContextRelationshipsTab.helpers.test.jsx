// @vitest-environment jsdom
// The plain-words account type behind the Type pill in a context's member
// table, and in the member-reference chips built on top of it.
import { describe, it, expect } from 'vitest';
import { accountTypeWord } from '@ui/components/ContextRelationshipsTab.helpers';

describe('accountTypeWord', () => {
  it('names a machine account in plain words', () => {
    expect(accountTypeWord('MachineAccount')).toBe('Machine account');
  });

  it('keeps the words of the other account kinds', () => {
    expect(accountTypeWord('User')).toBe('Member');
    expect(accountTypeWord('ServicePrincipal')).toBe('Service account');
    expect(accountTypeWord('AIAgent')).toBe('AI agent');
    expect(accountTypeWord('Guest')).toBe('Guest');
  });

  it('shows an unknown type as stored rather than guessing at it', () => {
    // `Computer` is not the accepted spelling, so it is not translated — it is
    // shown as the source sent it instead of being read as a machine account.
    expect(accountTypeWord('Computer')).toBe('Computer');
    expect(accountTypeWord(undefined)).toBeUndefined();
  });
});
