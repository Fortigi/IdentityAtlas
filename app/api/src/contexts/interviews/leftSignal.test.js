// Does a claim say the person left — in English and Dutch, from any person claim.
import { describe, it, expect } from 'vitest';
import { leftSignal, saysLeft, CORRECTED_CURRENT } from './leftSignal.js';

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

describe('leftSignal — a claim the sentence check corrected', () => {
  it('says nothing about leaving, whatever its words, once the value carries the correction', () => {
    expect(leftSignal(history({ value: 'left' }))).toBe(true);
    expect(leftSignal(history({ value: `left (${CORRECTED_CURRENT}, not left)` }))).toBe(false);
    expect(leftSignal(history({ value: `left (${CORRECTED_CURRENT}, not left)`, periodText: 'inmiddels uitgestroomd' }))).toBe(false);
  });
});

describe('saysReturned / returnSignal — left and came back', () => {
  it('reads the English and Dutch words for coming back', async () => {
    const { saysReturned } = await import('./leftSignal.js');
    for (const t of ['rejoined last year', 're-joined', 'came back as architect', 'is back in the team', 'returned in 2024', 'joined again',
      'is weer terug', 'teruggekomen', 'kwam terug als lead', 'terug als architect', 'opnieuw begonnen', 'weer bij het team',
      'is sinds ongeveer een half jaar terug, nu als architect', 'zijn sinds maart terug']) {
      expect(saysReturned(t), t).toBe(true);
    }
  });

  it('a bare "terug" or "weer" is not a return: "a year ago", the weather', async () => {
    const { saysReturned } = await import('./leftSignal.js');
    for (const t of ['een jaar terug vertrokken', 'sinds een jaar terug betrokken', 'het weer was slecht', 'feedback', 'terugkoppeling', 'backend', '', null]) {
      expect(saysReturned(t), String(t)).toBe(false);
    }
  });

  it('returnSignal: membership rejoined, or the words in a role claim\'s value or period', async () => {
    const { returnSignal, CORRECTED_RETURNED } = await import('./leftSignal.js');
    expect(returnSignal({ claimKind: 'membership', attribute: 'rejoined' })).toBe(true);
    expect(returnSignal({ claimKind: 'membership', attribute: 'joined', value: 'came back' })).toBe(false);
    expect(returnSignal(history({ value: 'architect', periodText: 'sinds zijn terugkeer; kwam terug in 2025' }))).toBe(true);
    expect(returnSignal(history({ value: `junior (${CORRECTED_RETURNED}, in it again)` }))).toBe(true);
    expect(returnSignal(history({ value: 'architect' }))).toBe(false);
    expect(returnSignal({ claimKind: 'alias', value: 'came back' })).toBe(false);
    expect(returnSignal(null)).toBe(false);
  });

  it('a role claim that says left AND came back is not gone', async () => {
    const { CORRECTED_RETURNED } = await import('./leftSignal.js');
    expect(leftSignal(history({ value: 'left in 2022, came back as architect' }))).toBe(false);
    expect(leftSignal(history({ value: 'architect', periodText: 'vertrokken, nu weer terug' }))).toBe(false);
    expect(leftSignal(history({ value: `left (${CORRECTED_RETURNED}, in it again)` }))).toBe(false);
  });
});
