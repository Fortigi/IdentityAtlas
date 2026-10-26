import { describe, it, expect } from 'vitest';
import { contextPageView, listsMembers } from './useContextDetail';

describe('contextPageView — what the page offers this reader', () => {
  it('gives a business reader nothing editable, whatever the context', () => {
    expect(contextPageView({ analyst: false, attrs: { variant: 'manual' } })).toEqual({ editable: false, membersEditable: false });
  });

  it('lets the analyst edit a context created here or derived, not an imported one', () => {
    const editable = (variant) => contextPageView({ analyst: true, attrs: { variant } }).editable;
    expect([editable('manual'), editable('generated'), editable('synced'), editable(undefined)]).toEqual([true, true, false, false]);
  });

  it('offers member edits only on a context created here, where adding and removing both last', () => {
    const members = (variant) => contextPageView({ analyst: true, attrs: { variant } }).membersEditable;
    expect([members('manual'), members('generated'), members('synced'), members(undefined)]).toEqual([true, false, false, false]);
  });
});

describe('listsMembers — whether the page reads the members as their source lists them', () => {
  it('not for a unit or an application of people, whose People overview shows them', () => {
    for (const contextCategory of ['OrganizationalUnit', 'LogicalApplication']) {
      for (const targetType of ['Principal', 'Identity']) expect(listsMembers({ contextCategory, targetType }), `${contextCategory}/${targetType}`).toBe(false);
    }
  });

  it('for a template of other members (resources, systems) and for every context without a template', () => {
    expect(listsMembers({ contextCategory: 'LogicalApplication', targetType: 'Resource' })).toBe(true);
    expect(listsMembers({ contextCategory: 'OrganizationalUnit', targetType: 'System' })).toBe(true);
    expect(listsMembers({ contextCategory: 'Tag', targetType: 'Principal' })).toBe(true);
    expect(listsMembers({ contextCategory: null, targetType: 'Identity' })).toBe(true);
  });

  it('nothing before the context is loaded', () => {
    expect(listsMembers(undefined)).toBe(false);
    expect(listsMembers(null)).toBe(false);
  });
});
