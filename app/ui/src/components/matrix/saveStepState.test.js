// Unit tests for the Save & share step's rules (#1202).
//
// Inputs discriminate: each primaryAction branch is driven with the neighbouring
// branch's trigger present too (a name AND recipients, an edited matrix AND a copy),
// so a swapped condition or a dropped guard lands in a different branch and fails.

import { describe, it, expect } from 'vitest';
import {
  LENS_VALUES, lensOf, isDirty, primaryAction, nameProblem, savedMatrixBody, copyNameOf, detachesFromSaved,
  autoMatrixName, nameForShare,
} from './saveStepState';

const EDITING = { id: 'sf-1', name: 'HR users', description: 'People in HR', filter: { managed: 'gaps' } };

describe('lensOf', () => {
  it('keeps the four known lenses and reads anything else as all', () => {
    expect(LENS_VALUES).toEqual(['all', 'managed', 'unmanaged', 'gaps']);
    for (const v of LENS_VALUES) expect(lensOf(v)).toBe(v);
    expect(lensOf('Governed')).toBe('all');
    expect(lensOf(undefined)).toBe('all');
  });
});

describe('isDirty', () => {
  const clean = { editing: EDITING, savedMatch: { id: 'sf-1' }, managed: 'gaps', name: 'HR users', description: 'People in HR' };

  it('is clean when nothing about the edited matrix changed — whitespace included', () => {
    expect(isDirty(clean)).toBe(false);
    expect(isDirty({ ...clean, name: '  HR users ', description: 'People in HR  ' })).toBe(false);
  });

  it('is never dirty without a matrix being edited', () => {
    expect(isDirty({ ...clean, editing: null, savedMatch: null, name: 'x' })).toBe(false);
  });

  it('is dirty when the filter no longer is that saved matrix', () => {
    expect(isDirty({ ...clean, savedMatch: null })).toBe(true);
    expect(isDirty({ ...clean, savedMatch: { id: 'sf-2' } })).toBe(true);
  });

  it('is dirty when the lens, the name or the description changed', () => {
    expect(isDirty({ ...clean, managed: 'all' })).toBe(true);
    expect(isDirty({ ...clean, name: 'HR people' })).toBe(true);
    expect(isDirty({ ...clean, description: '' })).toBe(true);
  });

  it('compares a stored lens outside the known four as all', () => {
    const odd = { ...EDITING, filter: { managed: 'Governed' } };
    expect(isDirty({ ...clean, editing: odd, managed: 'all' })).toBe(false);
    expect(isDirty({ ...clean, editing: { ...EDITING, filter: undefined }, managed: 'all' })).toBe(false);
  });

  it('treats a missing description on both sides as unchanged', () => {
    expect(isDirty({ ...clean, editing: { ...EDITING, description: null }, description: undefined })).toBe(false);
  });
});

describe('primaryAction', () => {
  it('shows without saving when there is no name and nobody to share with', () => {
    expect(primaryAction({ name: '   ', recipientCount: 0 })).toEqual({ kind: 'show', label: 'Show matrix' });
    // …even while editing a changed matrix: an emptied name means "don't save".
    expect(primaryAction({ name: '', editing: EDITING, dirty: true })).toEqual({ kind: 'show', label: 'Show matrix' });
  });

  it('needs a name the moment one person is picked', () => {
    expect(primaryAction({ name: '', recipientCount: 1 })).toEqual({ kind: 'needName', label: 'Save & show' });
  });

  it('creates a new matrix when named and not editing one', () => {
    expect(primaryAction({ name: 'Sales', recipientCount: 2 })).toEqual({ kind: 'create', label: 'Save & show' });
    expect(primaryAction({ name: 'Sales' })).toEqual({ kind: 'create', label: 'Save & show' });
  });

  it('creates rather than updates when saving the edited matrix as a copy', () => {
    expect(primaryAction({ name: 'HR copy', editing: EDITING, copy: true, dirty: true }))
      .toEqual({ kind: 'create', label: 'Save & show' });
  });

  it('updates the edited matrix when it changed', () => {
    expect(primaryAction({ name: 'HR users', editing: EDITING, dirty: true, recipientCount: 1 }))
      .toEqual({ kind: 'update', label: 'Save changes & show' });
  });

  it('only shares an unchanged edited matrix when people were picked', () => {
    expect(primaryAction({ name: 'HR users', editing: EDITING, recipientCount: 1 }))
      .toEqual({ kind: 'share', label: 'Share & show' });
  });

  it('just shows an unchanged edited matrix shared with nobody new', () => {
    expect(primaryAction({ name: 'HR users', editing: EDITING })).toEqual({ kind: 'show', label: 'Show matrix' });
  });
});

describe('nameProblem', () => {
  it('asks for a name to share', () => {
    expect(nameProblem({ kind: 'needName' }, { name: '' })).toBe('Name this matrix to share it');
  });

  it('refuses a copy under the original name, ignoring surrounding spaces', () => {
    expect(nameProblem({ kind: 'create' }, { name: ' HR users ', editing: EDITING, copy: true }))
      .toBe('Give the copy a different name');
  });

  it('accepts a copy under a new name, and the original name when not copying', () => {
    expect(nameProblem({ kind: 'create' }, { name: 'HR users 2', editing: EDITING, copy: true })).toBeNull();
    expect(nameProblem({ kind: 'update' }, { name: 'HR users', editing: EDITING, copy: false })).toBeNull();
    expect(nameProblem({ kind: 'create' }, { name: 'HR users', editing: null, copy: true })).toBeNull();
  });
});

describe('savedMatrixBody', () => {
  it('trims the name, folds the lens into the filter and keeps the filter content', () => {
    const filter = { rowType: 'identity', foldAttributes: true };
    expect(savedMatrixBody({ name: '  Sales  ', description: ' Team access ', filter, managed: 'unmanaged' }))
      .toEqual({ name: 'Sales', description: 'Team access', filter: { rowType: 'identity', foldAttributes: true, managed: 'unmanaged' } });
    expect(filter).not.toHaveProperty('managed');
  });

  it('stores a blank or missing description as none', () => {
    expect(savedMatrixBody({ name: 'S', description: '   ', filter: {}, managed: 'all' }).description).toBeNull();
    expect(savedMatrixBody({ name: 'S', filter: {}, managed: 'all' }).description).toBeNull();
  });
});

describe('copyNameOf', () => {
  it('suggests a name that differs from the original', () => {
    expect(copyNameOf(' HR users ')).toBe('HR users (copy)');
    expect(nameProblem({ kind: 'create' }, { name: copyNameOf(EDITING.name), editing: EDITING, copy: true })).toBeNull();
  });
});

describe('detachesFromSaved', () => {
  it('lets go of the edited matrix only when its name is emptied', () => {
    expect(detachesFromSaved({ editing: EDITING, name: '' })).toBe(true);
    expect(detachesFromSaved({ editing: EDITING, name: '   ' })).toBe(true);
    expect(detachesFromSaved({ editing: EDITING, name: 'HR use' })).toBe(false);
  });

  it('does nothing for a new matrix, or one already detached as a copy', () => {
    expect(detachesFromSaved({ editing: null, name: '' })).toBe(false);
    expect(detachesFromSaved({ editing: EDITING, copy: true, name: '' })).toBe(false);
  });
});

// ─── Sharing saves the matrix ──────────────────────────────────────────────
//
// A share is a property of a SAVED matrix, so picking the first person has to
// save one. The generated name is shown in the name field and can be changed,
// so it has to be readable — and a second attempt has to stay tellable apart
// from the first.

describe('autoMatrixName', () => {
  const AT = new Date(2026, 8, 22, 9, 5); // 22 Sep 2026, 09:05 — local time

  it('reads as a date a person can recognise, zero-padded to the minute', () => {
    expect(autoMatrixName(AT)).toBe('Matrix — 22 Sep 2026, 09:05');
  });

  it('numbers a second attempt from two, because the first one is not "(1)"', () => {
    expect(autoMatrixName(AT, 1)).toBe('Matrix — 22 Sep 2026, 09:05 (2)');
    expect(autoMatrixName(AT, 2)).toBe('Matrix — 22 Sep 2026, 09:05 (3)');
  });

  it('names the right month, not the one either side of it', () => {
    expect(autoMatrixName(new Date(2026, 0, 1, 0, 0))).toBe('Matrix — 1 Jan 2026, 00:00');
    expect(autoMatrixName(new Date(2026, 11, 31, 23, 59))).toBe('Matrix — 31 Dec 2026, 23:59');
  });
});

describe('nameForShare', () => {
  const AT = new Date(2026, 8, 22, 9, 5);

  it('keeps the name the author typed, trimmed, and says it was not generated', () => {
    expect(nameForShare({ name: '  Sales access ', now: AT })).toEqual({ name: 'Sales access', generated: false });
  });

  it('generates one when the field is empty, and says so', () => {
    expect(nameForShare({ name: '', now: AT })).toEqual({ name: 'Matrix — 22 Sep 2026, 09:05', generated: true });
  });

  it('treats a field holding only spaces as empty, rather than saving a blank name', () => {
    expect(nameForShare({ name: '   ', now: AT }).generated).toBe(true);
  });

  it('only numbers the attempt when the name is generated', () => {
    // A name the author typed is theirs: a clash comes back to them on the
    // field, and is never silently renamed to "… (2)".
    expect(nameForShare({ name: 'Sales access', now: AT, attempt: 1 }).name).toBe('Sales access');
    expect(nameForShare({ name: '', now: AT, attempt: 1 }).name).toBe('Matrix — 22 Sep 2026, 09:05 (2)');
  });
});
