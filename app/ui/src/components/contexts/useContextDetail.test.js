import { describe, it, expect } from 'vitest';
import { contextPageView } from './useContextDetail';

const keys = (tabs) => tabs.filter(Boolean).map(t => t.key);

describe('contextPageView — what the page offers this reader', () => {
  it('gives a business reader the members only, nothing editable, whatever tab was asked', () => {
    expect(contextPageView({ analyst: false, attrs: { variant: 'manual' }, hasRisk: true, memberTotal: 3, activeTab: 'timeline' }))
      .toEqual({ editable: false, membersEditable: false, tabs: null, shownTab: 'members' });
  });

  it('gives the analyst the tabs, Risk only when scored, and the asked tab', () => {
    const scored = contextPageView({ analyst: true, attrs: { variant: 'synced' }, hasRisk: true, memberTotal: 7, activeTab: 'timeline' });
    expect(keys(scored.tabs)).toEqual(['members', 'timeline', 'risk']);
    expect(scored.tabs[0].count).toBe(7);
    expect(scored.shownTab).toBe('timeline');
    expect(keys(contextPageView({ analyst: true, attrs: {}, hasRisk: false, memberTotal: 0, activeTab: 'members' }).tabs)).toEqual(['members', 'timeline']);
  });

  it('lets the analyst edit a context created here or derived, not an imported one', () => {
    const editable = (variant) => contextPageView({ analyst: true, attrs: { variant }, activeTab: 'members' }).editable;
    expect([editable('manual'), editable('generated'), editable('synced'), editable(undefined)]).toEqual([true, true, false, false]);
  });

  it('offers member edits only on a context created here, where adding and removing both last', () => {
    const members = (variant) => contextPageView({ analyst: true, attrs: { variant }, activeTab: 'members' }).membersEditable;
    expect([members('manual'), members('generated'), members('synced'), members(undefined)]).toEqual([true, false, false, false]);
  });
});
