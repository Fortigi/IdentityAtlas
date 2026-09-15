// Unit tests for the share-state helpers (#1202).
//
// Inputs are chosen to discriminate: every "is it shared?" case is driven with a
// REVOKED share present as well as a live one, because the bug these guard
// against is a matrix that still reads as shared after its link was revoked.

import { describe, it, expect } from 'vitest';
import {
  matchSavedMatrix, activeShareOf, sharedWithLabel, liveShareWarning, wizardPreferredSavedId, tagWithSavedMatrix,
  savedMatrixLoadArgs, currentSavedMatrix, appliedSavedMatrix, copyName, renameShareWarning, shareRequestBody,
} from './shareState';

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

describe('savedMatrixLoadArgs', () => {
  it('applies the stored filter tagged with its id, and hands the governed toggle over separately', () => {
    const [filter, managed] = savedMatrixLoadArgs({ id: 'sf-1', filter: { ...FILTER, managed: 'gaps' } });
    expect(filter).toEqual({ ...FILTER, savedFilterId: 'sf-1' });
    expect(filter).not.toHaveProperty('managed');
    expect(managed).toBe('gaps');
  });

  it('accepts each of the four governed states and falls back to "all" for anything else', () => {
    for (const m of ['all', 'managed', 'unmanaged', 'gaps']) {
      expect(savedMatrixLoadArgs({ id: 'x', filter: { managed: m } })[1]).toBe(m);
    }
    expect(savedMatrixLoadArgs({ id: 'x', filter: { managed: 'governed' } })[1]).toBe('all');
    expect(savedMatrixLoadArgs({ id: 'x', filter: FILTER })[1]).toBe('all');
  });

  it('survives a row with no filter at all', () => {
    expect(savedMatrixLoadArgs({ id: 'sf-9' })).toEqual([{ savedFilterId: 'sf-9' }, 'all']);
  });
});

describe('currentSavedMatrix', () => {
  const CHANGED = { ...FILTER, rowType: 'identity' };

  it('is the saved matrix the view was loaded from, unchanged', () => {
    expect(currentSavedMatrix(SAVED, { ...FILTER, savedFilterId: 'sf-1' })).toEqual({ current: SAVED[0], diverged: false });
  });

  it('keeps the name of the matrix it came from after a change, and says it diverged', () => {
    expect(currentSavedMatrix(SAVED, { ...CHANGED, savedFilterId: 'sf-1' })).toEqual({ current: SAVED[0], diverged: true });
  });

  it('diverges from its origin even when the change happens to equal ANOTHER saved matrix', () => {
    // Loaded from "Everyone" (sf-2), then narrowed into exactly HR users' filter.
    expect(currentSavedMatrix(SAVED, { ...FILTER, savedFilterId: 'sf-2' })).toEqual({ current: SAVED[1], diverged: true });
  });

  it('never calls a matrix that was never saved "changed"', () => {
    expect(currentSavedMatrix(SAVED, CHANGED)).toEqual({ current: null, diverged: false });
  });

  it('names an untagged view by content, without calling it changed', () => {
    expect(currentSavedMatrix(SAVED, FILTER)).toEqual({ current: SAVED[0], diverged: false });
  });

  it('forgets a tag whose saved matrix is gone', () => {
    expect(currentSavedMatrix(SAVED, { ...CHANGED, savedFilterId: 'sf-deleted' })).toEqual({ current: null, diverged: false });
    expect(currentSavedMatrix(null, { ...FILTER, savedFilterId: 'sf-1' })).toEqual({ current: null, diverged: false });
  });
});

describe('shareRequestBody', () => {
  const people = [{ userKey: 'ann@contoso.com', displayName: 'Ann' }];

  it('shares a saved matrix by id and sends nothing that would rename or re-save it', () => {
    expect(shareRequestBody({ savedFilterId: 'sf-1', name: 'Other name', filter: FILTER, managed: 'gaps', recipients: people }))
      .toEqual({ savedFilterId: 'sf-1', recipients: people });
  });

  it('saves and shares an unsaved matrix under the trimmed name, with its lens and display mode', () => {
    expect(shareRequestBody({ name: '  Sales team  ', filter: FILTER, managed: 'gaps', recipients: people }))
      .toEqual({ name: 'Sales team', filter: FILTER, managed: 'gaps', displayMode: 'grid', recipients: people });
  });

  it('records a rotated or rolled-up matrix as such, and a missing lens as all', () => {
    const rotated = { ...FILTER, orientation: 'rows-as-subjects' };
    expect(shareRequestBody({ name: 'R', filter: rotated, recipients: people })).toMatchObject({ displayMode: 'rotated', managed: 'all' });
    expect(shareRequestBody({ name: 'U', filter: { ...FILTER, rollup: 'department' }, managed: '', recipients: people }))
      .toMatchObject({ displayMode: 'rollup', managed: 'all' });
  });

  it('never sends a name of undefined', () => {
    expect(shareRequestBody({ filter: FILTER, recipients: people }).name).toBe('');
  });
});

describe('appliedSavedMatrix', () => {
  const match = { id: 'sf-match' };
  const editing = { id: 'sf-edit' };
  const openedOn = (savedFilterId) => ({ ...FILTER, savedFilterId });

  it('prefers the saved matrix the result IS, then the one being edited', () => {
    expect(appliedSavedMatrix({ savedMatch: match, editingSaved: editing, savedFilters: SAVED, initialFilter: openedOn('sf-1') })).toBe(match);
    expect(appliedSavedMatrix({ savedMatch: null, editingSaved: editing, savedFilters: SAVED, initialFilter: openedOn('sf-1') })).toBe(editing);
  });

  it('falls back to the saved matrix the wizard was opened on, when it still exists', () => {
    expect(appliedSavedMatrix({ savedMatch: null, editingSaved: null, savedFilters: SAVED, initialFilter: openedOn('sf-2') })).toBe(SAVED[1]);
    expect(appliedSavedMatrix({ savedMatch: null, editingSaved: null, savedFilters: SAVED, initialFilter: openedOn('sf-gone') })).toBeNull();
  });

  it('tags nothing for a matrix that never came from a saved one', () => {
    expect(appliedSavedMatrix({ savedMatch: null, editingSaved: null, savedFilters: SAVED, initialFilter: FILTER })).toBeNull();
    expect(appliedSavedMatrix({ savedMatch: null, editingSaved: null, savedFilters: SAVED, initialFilter: null })).toBeNull();
    expect(appliedSavedMatrix({ savedMatch: null, editingSaved: null, savedFilters: null, initialFilter: openedOn('sf-1') })).toBeNull();
  });
});

describe('copyName / renameShareWarning', () => {
  it('offers "Copy of <name>" for a duplicate', () => {
    expect(copyName('HR users')).toBe('Copy of HR users');
  });

  it('warns that recipients see a new name only when the matrix is shared', () => {
    expect(renameShareWarning({ shared: true, recipientCount: 1 })).toBe('Shared with 1 person — they will see the new name.');
    expect(renameShareWarning({ shared: false, recipientCount: 4 })).toBe('');
    expect(renameShareWarning(null)).toBe('');
  });
});
