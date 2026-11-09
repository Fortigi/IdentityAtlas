// Reading an account-linking run row.
//
// Both readers turn on one distinction: a nullable figure that was never measured must not
// be reported as a measured zero. "0 name-only matches held for review" is a finding about
// a run that looked; a run from before the guard existed never looked, and saying it found
// none would be a claim the data does not support.

import { describe, it, expect } from 'vitest';
import { completionNotice, latestNameOnlyRun } from './accountLinkingRuns';

describe('completionNotice', () => {
  it('adds the two name-only figures when the run measured them', () => {
    expect(completionNotice({
      linksCreated: 1, linksUpdated: 0, orphansRemaining: 4, nameOnlyMatches: 3, linksRemoved: 2,
    })).toBe('Linking complete — 1 linked, 0 updated, 4 orphans remaining, '
      + '3 name-only matches held for review, 2 name-only links removed.');
  });

  it('omits them entirely for a run that predates the feature', () => {
    expect(completionNotice({ linksCreated: 1, linksUpdated: 0, orphansRemaining: 4 }))
      .toBe('Linking complete — 1 linked, 0 updated, 4 orphans remaining.');
  });

  it('reports a measured zero, which is not the same as not measured', () => {
    // `!= null`, not a truthiness check: 0 is the interesting answer here — the run looked
    // and held nothing back — and a truthy test would drop exactly that case.
    expect(completionNotice({ nameOnlyMatches: 0, linksRemoved: 0 }))
      .toBe('Linking complete — 0 linked, 0 updated, — orphans remaining, '
        + '0 name-only matches held for review, 0 name-only links removed.');
  });

  it('shows an em dash for an unknown orphan count but zero for unknown link counts', () => {
    expect(completionNotice({})).toBe('Linking complete — 0 linked, 0 updated, — orphans remaining.');
  });

  it('reports the re-linked matches on the run that actually re-linked them', () => {
    // The first run after the level-scoped guard lands re-links the whole class the old
    // reading held or detached. Without this clause that restore is invisible, and an
    // analyst sees a few thousand accounts change owner with nothing saying why.
    expect(completionNotice({
      linksCreated: 2100, linksUpdated: 0, orphansRemaining: 4, nameOnlyMatches: 80,
      linksRemoved: 0, linksRestored: 2043,
    })).toBe('Linking complete — 2100 linked, 0 updated, 4 orphans remaining, '
      + '80 name-only matches held for review, 0 name-only links removed, '
      + '2043 previously-held matches re-linked.');
  });

  it('says nothing about re-linking on an ordinary run that restored none', () => {
    // Unlike the figures above, zero is not a finding here: every later run reports 0 and
    // a standing "0 previously-held matches re-linked" would read as a thing to look into.
    expect(completionNotice({
      linksCreated: 1, linksUpdated: 0, orphansRemaining: 4, nameOnlyMatches: 3,
      linksRemoved: 0, linksRestored: 0,
    })).toBe('Linking complete — 1 linked, 0 updated, 4 orphans remaining, '
      + '3 name-only matches held for review, 0 name-only links removed.');
  });
});

describe('latestNameOnlyRun', () => {
  const measured = { id: 3, status: 'completed', nameOnlySuggestions: [] };

  it('picks the newest completed run that actually measured', () => {
    // The API returns newest-first, so the first qualifying row wins. A run still in
    // flight has no final figures, and a pre-feature run carries null — reading either as
    // the answer would show an empty list to a tenant that has matches waiting.
    expect(latestNameOnlyRun({ data: [
      { id: 5, status: 'running', nameOnlySuggestions: [{ principalId: 'p1' }] },
      { id: 4, status: 'completed', nameOnlySuggestions: null },
      measured,
    ] })).toBe(measured);
  });

  it('skips a failed run even when it recorded a list', () => {
    expect(latestNameOnlyRun({ data: [{ id: 1, status: 'failed', nameOnlySuggestions: [] }] })).toBeNull();
  });

  it('returns null for a payload that carries no run list', () => {
    expect(latestNameOnlyRun({})).toBeNull();
    expect(latestNameOnlyRun({ data: null })).toBeNull();
    expect(latestNameOnlyRun(null)).toBeNull();
    expect(latestNameOnlyRun(undefined)).toBeNull();
  });
});
