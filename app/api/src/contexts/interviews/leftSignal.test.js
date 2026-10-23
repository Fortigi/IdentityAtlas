// Does a claim say the person left — in English and Dutch, from any person claim.
import { describe, it, expect } from 'vitest';
import { leftSignal, saysLeft } from './leftSignal.js';

const history = (over) => ({ claimKind: 'roleHistory', attribute: 'member', value: 'developer', periodText: null, ...over });

describe('saysLeft', () => {
  it('reads the English words for leaving', () => {
    for (const t of ['left', 'recently left', 'no longer on the team', 'former lead', 'formerly the architect', 'quit last year', 'departed', 'has moved on']) {
      expect(saysLeft(t), t).toBe(true);
    }
  });

  it('reads the Dutch words for leaving', () => {
    for (const t of ['inmiddels uitgestroomd', 'vertrokken', 'is weg', 'doet het niet meer', 'gestopt', 'voormalig beheerder', 'voormalige eigenaar', 'oud-medewerker']) {
      expect(saysLeft(t), t).toBe(true);
    }
  });

  it('matches whole words only, and nothing in an ordinary role', () => {
    for (const t of ['leftover tasks', 'wegwerken van achterstand', 'meer dan genoeg', 'oud', 'developer', 'still on it', 'the lead', '', null, undefined]) {
      expect(saysLeft(t), String(t)).toBe(false);
    }
  });
});

describe('leftSignal', () => {
  it('a membership claim says it by its status only', () => {
    expect(leftSignal({ claimKind: 'membership', attribute: 'former', value: 'x' })).toBe(true);
    expect(leftSignal({ claimKind: 'membership', attribute: 'left', value: 'x' })).toBe(true);
    expect(leftSignal({ claimKind: 'membership', attribute: 'current', value: 'left' })).toBe(false);
    expect(leftSignal({ claimKind: 'membership', attribute: 'joined', periodText: 'vertrokken' })).toBe(false);
  });

  it('a role or roleHistory claim says it in its value or its period', () => {
    expect(leftSignal(history({ value: 'left', periodText: 'recent' }))).toBe(true);
    expect(leftSignal(history({ value: 'worked', periodText: 'inmiddels uitgestroomd' }))).toBe(true);
    expect(leftSignal({ claimKind: 'role', attribute: 'other', value: 'former owner' })).toBe(true);
    expect(leftSignal(history({ value: 'worked', periodText: 'for a while' }))).toBe(false);
  });

  it('"no longer the owner" gives up the role, not the context; other kinds never say it', () => {
    expect(leftSignal({ claimKind: 'role', attribute: 'notOwner', value: 'no longer the owner' })).toBe(false);
    expect(leftSignal({ claimKind: 'description', value: 'the old team left' })).toBe(false);
    expect(leftSignal({ claimKind: 'property', attribute: 'status', value: 'former' })).toBe(false);
    expect(leftSignal(null)).toBe(false);
  });
});
