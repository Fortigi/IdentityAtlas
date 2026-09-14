// Unit tests for the share-state helpers (#1202).
//
// Inputs are chosen to discriminate: every "is it shared?" case is driven with a
// REVOKED share present as well as a live one, because the bug these guard
// against is a matrix that still reads as shared after its link was revoked.

import { describe, it, expect } from 'vitest';
import { matchSavedMatrix, activeShareOf, sharedWithLabel, liveShareWarning, wizardPreferredSavedId, tagWithSavedMatrix } from './shareState';

const FILTER = {
  rowType: 'principal',
  subject: { include: [{ kind: 'attribute', field: 'department', values: ['HR'] }], exclude: [] },
  resource: { include: [], exclude: [] },
};
const SAVED = [
  { id: 'sf-1', name: 'HR users', filter: FILTER },
  { id: 'sf-2', name: 'Everyone', filter: { ...FILTER, subject: { include: [], exclude: [] } } },
];

describe('matchSavedMatrix', () => {
  it('finds the saved matrix the current filter is', () => {
    expect(matchSavedMatrix(SAVED, FILTER)?.id).toBe('sf-1');
  });

  it('still recognises it after a fold or a drill, which change nothing real', () => {
    const drilled = { ...FILTER, rollupExpanded: ['node-1'], rollupPath: ['node-1'], foldAttributes: true };
    expect(matchSavedMatrix(SAVED, drilled)?.id).toBe('sf-1');
  });

  describe('two saved matrices with identical filters', () => {
    // "Sales team" was shared off "HR users" without changing it: same content,
    // different matrix. Listed FIRST so that "first match wins" would pick the
    // wrong one — only the loaded-from id can pick right.
    const twins = [{ id: 'sf-share', name: 'Sales team', filter: FILTER, shared: true }, ...SAVED];

    it('picks the one the view was loaded from', () => {
      expect(matchSavedMatrix(twins, { ...FILTER, savedFilterId: 'sf-1' })?.name).toBe('HR users');
      expect(matchSavedMatrix(twins, { ...FILTER, savedFilterId: 'sf-share' })?.name).toBe('Sales team');
    });

    it('lets an explicit preference override the tag on the filter', () => {
      expect(matchSavedMatrix(twins, { ...FILTER, savedFilterId: 'sf-share' }, 'sf-1')?.name).toBe('HR users');
    });

    it('ignores a tag whose matrix no longer has this content, falling back to a content match', () => {
      // Loaded from "Everyone", then changed into HR users' filter.
      expect(matchSavedMatrix(twins, { ...FILTER, savedFilterId: 'sf-2' })?.id).toBe('sf-share');
      expect(matchSavedMatrix(twins, { ...FILTER, savedFilterId: 'sf-deleted' })?.id).toBe('sf-share');
    });

    it('prefers the org default for an untagged view, before whichever twin sorts first', () => {
      const withDefault = [twins[0], { ...twins[1], isDefault: true }];
      expect(matchSavedMatrix(withDefault, FILTER)?.id).toBe('sf-1');
      // …and the default still yields to an explicit tag.
      expect(matchSavedMatrix(withDefault, { ...FILTER, savedFilterId: 'sf-share' })?.id).toBe('sf-share');
    });

    it('does not let the tag itself make two filters differ', () => {
      expect(matchSavedMatrix(SAVED, { ...FILTER, savedFilterId: 'anything' })?.id).toBe('sf-1');
    });
  });

  it('returns null for a filter that genuinely differs, and for missing inputs', () => {
    expect(matchSavedMatrix(SAVED, { ...FILTER, rowType: 'identity' })).toBeNull();
    expect(matchSavedMatrix(SAVED, null)).toBeNull();
    expect(matchSavedMatrix(null, FILTER)).toBeNull();
  });
});

describe('activeShareOf', () => {
  const shares = [
    { id: 'sh-old', savedFilterId: 'sf-1', revokedAt: '2026-09-01T10:00:00Z' },
    { id: 'sh-live', savedFilterId: 'sf-1', revokedAt: null },
    { id: 'sh-other', savedFilterId: 'sf-2', revokedAt: null },
  ];

  it('picks the live share of the matrix, never a revoked one', () => {
    expect(activeShareOf(shares, 'sf-1').id).toBe('sh-live');
  });

  it('returns null when every share of that matrix was revoked', () => {
    expect(activeShareOf([shares[0]], 'sf-1')).toBeNull();
  });

  it('returns null without a matrix id or a list', () => {
    expect(activeShareOf(shares, null)).toBeNull();
    expect(activeShareOf(null, 'sf-1')).toBeNull();
  });
});

describe('sharedWithLabel', () => {
  it('agrees with itself on singular and plural', () => {
    expect(sharedWithLabel(1)).toBe('Shared with 1 person');
    expect(sharedWithLabel(3)).toBe('Shared with 3 people');
    expect(sharedWithLabel(0)).toBe('Shared with 0 people');
    expect(sharedWithLabel(undefined)).toBe('Shared with 0 people');
  });
});

describe('liveShareWarning', () => {
  it('counts the recipients it was given, list or count', () => {
    expect(liveShareWarning({ recipients: [{ userKey: 'a' }, { userKey: 'b' }] }))
      .toBe('Shared with 2 people — they will see this change.');
    expect(liveShareWarning({ recipientCount: 1 }))
      .toBe('Shared with 1 person — they will see this change.');
  });

  it('says nothing when there is no share to warn about', () => {
    expect(liveShareWarning(null)).toBe('');
  });
});

describe('wizardPreferredSavedId', () => {
  it('prefers the matrix being edited over the one the wizard was opened on', () => {
    expect(wizardPreferredSavedId({ id: 'sf-edit' }, { savedFilterId: 'sf-open' })).toBe('sf-edit');
    expect(wizardPreferredSavedId(null, { savedFilterId: 'sf-open' })).toBe('sf-open');
    expect(wizardPreferredSavedId(null, undefined)).toBeUndefined();
  });
});

describe('tagWithSavedMatrix', () => {
  it('tags a saved matrix with its id and leaves an unsaved one untouched', () => {
    expect(tagWithSavedMatrix(FILTER, { id: 'sf-1' })).toEqual({ ...FILTER, savedFilterId: 'sf-1' });
    expect(tagWithSavedMatrix(FILTER, null)).toBe(FILTER);
    expect(FILTER).not.toHaveProperty('savedFilterId');
  });
});
