import { describe, it, expect } from 'vitest';
import {
  addTerm, EMPTY_RECIPE, isRecipeRoot, mergeTerms, relatedWordText, removeTerm, rowAction, saveBlocker,
  setObjectChoice, setTermMatch, termCounts, termKey, termsReplyText, toggleListValue, toggleTerm, widenWarning,
} from './recipeDraft';

const draft = (over = {}) => ({ ...EMPTY_RECIPE, ...over });

describe('recipeDraft', () => {
  it('termKey reduces punctuation and case the way the server does', () => {
    expect(termKey('SG_Inkoop-Users (P&O)')).toBe('sg inkoop users p o');
  });

  it('mergeTerms appends only new terms and leaves the draft untouched when nothing is new', () => {
    const r = draft({ terms: [{ text: 'Inkoop', key: 'inkoop', state: 'rejected' }] });
    const merged = mergeTerms(r, [{ text: 'INKOOP', state: 'accepted' }, { text: 'Coupa' }, { text: 'coupa' }]);
    expect(merged.terms.map(t => [t.text, t.state])).toEqual([['Inkoop', 'rejected'], ['Coupa', undefined]]);
    expect(mergeTerms(r, [{ text: 'inkoop' }])).toBe(r);
  });

  it('addTerm matches short terms as whole words and records where the term came from', () => {
    const r = addTerm(addTerm(draft(), 'INK'), 'Zaaksysteem', 'related');
    expect(r.terms).toEqual([
      { text: 'INK', key: 'ink', match: 'token', state: 'accepted', origin: 'analyst' },
      { text: 'Zaaksysteem', key: 'zaaksysteem', match: 'wordStart', state: 'accepted', origin: 'related' },
    ]);
    expect(addTerm(draft(), ' - ')).toEqual(draft());
  });

  it('toggles, re-matches and removes one term by key', () => {
    let r = addTerm(addTerm(draft(), 'inkoop'), 'coupa');
    r = toggleTerm(r, 'inkoop');
    r = setTermMatch(r, 'coupa', 'contains');
    expect(r.terms.map(t => [t.key, t.state, t.match])).toEqual([['inkoop', 'rejected', 'wordStart'], ['coupa', 'accepted', 'contains']]);
    expect(setTermMatch(r, 'coupa', 'regex')).toBe(r);
    expect(termCounts(r)).toEqual({ kept: 1, dropped: 1 });
    expect(removeTerm(r, 'inkoop').terms.map(t => t.key)).toEqual(['coupa']);
  });

  it('an object is in include or exclude, never both, and auto clears it', () => {
    let r = setObjectChoice(draft(), 'a', 'include');
    r = setObjectChoice(r, 'a', 'exclude');
    expect([r.include, r.exclude]).toEqual([[], ['a']]);
    r = setObjectChoice(r, 'a', 'auto');
    expect([r.include, r.exclude]).toEqual([[], []]);
  });

  it('never empties a list setting', () => {
    const r = draft({ fields: ['displayName'] });
    expect(toggleListValue(r, 'fields', 'displayName')).toBe(r);
    expect(toggleListValue(r, 'fields', 'mail').fields).toEqual(['displayName', 'mail']);
  });

  it('saveBlocker names the first thing missing', () => {
    const withTerm = addTerm(draft(), 'inkoop');
    expect(saveBlocker(withTerm, 3)).toBe('Give the context a name.');
    expect(saveBlocker(draft({ name: 'X' }), 3)).toBe('Keep at least one term, or include an object by hand.');
    expect(saveBlocker({ ...withTerm, name: 'X' }, 0)).toBe('Nothing matches yet.');
    expect(saveBlocker({ ...withTerm, name: 'X' }, 3)).toBeNull();
    expect(saveBlocker(draft({ name: 'X', include: ['a'] }), 1)).toBeNull();
  });

  it('rowAction offers the opposite of the current status', () => {
    expect(['member', 'included', 'excluded', 'candidate'].map(s => rowAction(s).choice)).toEqual(['exclude', 'auto', 'auto', 'include']);
  });

  it('isRecipeRoot only for the root of a context-recipe tree', () => {
    expect(isRecipeRoot({ sourceAlgorithmName: 'context-recipe', parentContextId: null })).toBe(true);
    expect(isRecipeRoot({ sourceAlgorithmName: 'context-recipe', parentContextId: 'p' })).toBe(false);
    expect(isRecipeRoot({ sourceAlgorithmName: 'resource-cluster' })).toBe(false);
  });

  it("widenWarning fires when the model's terms bring in far more than everything else", () => {
    expect(widenWarning({ memberCount: 43, addedByModel: 40 })).toEqual({ added: 40, rest: 3 });
    // Exactly twice the rest is not yet "far more".
    expect(widenWarning({ memberCount: 30, addedByModel: 20 })).toBeNull();
    // A handful is not worth a warning, whatever the ratio.
    expect(widenWarning({ memberCount: 9, addedByModel: 9 })).toBeNull();
    expect(widenWarning({ memberCount: 10, addedByModel: 10 })).toEqual({ added: 10, rest: 0 });
    expect(widenWarning(null)).toBeNull();
  });

  it('termsReplyText explains which terms are ticked and why the rest are not', () => {
    const t = (state) => ({ state });
    expect(termsReplyText([])).toBe('I have no new terms to add.');
    expect(termsReplyText([t('accepted'), t('accepted')])).toBe('I proposed 2 search terms, all containing your own words. Check what each one finds below.');
    expect(termsReplyText([t('accepted'), t('rejected'), t('rejected')])).toBe('I proposed 3 search terms. 1 contain your own words and are ticked; the other 2 are suggestions and start unticked — tick the ones that fit, looking at what each one finds.');
    expect(termsReplyText([t('rejected')])).toMatch(/^I proposed 1 search terms\. None contain your own words; the other 1 /);
  });

  it('relatedWordText says what adding the word would bring in', () => {
    expect(relatedWordText({ inContext: 6, outside: 0 })).toBe('in 6 of the context · nowhere else');
    expect(relatedWordText({ inContext: 2, outside: 3 })).toBe('in 2 of the context · 3 elsewhere');
  });
});
