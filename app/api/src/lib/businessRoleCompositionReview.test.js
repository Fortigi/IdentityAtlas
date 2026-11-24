import { describe, it, expect, vi } from 'vitest';
import {
  parseReviewBody, changesSince, reviewSummary, loadCompositionReviews, saveCompositionReview,
  CURRENT_COMPOSITION_SQL, REVIEWS_SQL, INSERT_REVIEW_SQL, MAX_NOTES, HISTORY_LIMIT,
} from './businessRoleCompositionReview.js';

const FIN = { id: 'g1', displayName: 'SG-Finance' };
const PAY = { id: 'g2', displayName: 'SG-Payroll' };
const HR = { id: 'g3', displayName: 'SG-HR' };

describe('parseReviewBody', () => {
  it('keeps trimmed notes and a sign-off', () => {
    expect(parseReviewBody({ notes: '  looks right  ', signedOff: true })).toEqual({ notes: 'looks right', signedOff: true });
  });

  it('accepts notes without a sign-off, and a sign-off without notes', () => {
    expect(parseReviewBody({ notes: 'Why is SG-HR in here?' })).toEqual({ notes: 'Why is SG-HR in here?', signedOff: false });
    expect(parseReviewBody({ signedOff: true })).toEqual({ notes: '', signedOff: true });
  });

  it('refuses a review that says nothing', () => {
    expect(parseReviewBody({ notes: '   ', signedOff: false })).toEqual({ error: 'Write a note or sign off' });
    expect(parseReviewBody({})).toEqual({ error: 'Write a note or sign off' });
    expect(parseReviewBody(undefined)).toEqual({ error: 'Write a note or sign off' });
  });

  it('refuses the wrong shapes', () => {
    expect(parseReviewBody({ notes: 5, signedOff: true })).toEqual({ error: 'notes must be text' });
    expect(parseReviewBody({ notes: 'x', signedOff: 'yes' })).toEqual({ error: 'signedOff must be true or false' });
  });

  it('allows notes up to the limit and no further', () => {
    expect(parseReviewBody({ notes: 'a'.repeat(MAX_NOTES) }).notes).toHaveLength(MAX_NOTES);
    expect(parseReviewBody({ notes: 'a'.repeat(MAX_NOTES + 1) })).toEqual({ error: `notes can be at most ${MAX_NOTES} characters` });
  });
});

describe('changesSince', () => {
  it('names what was added and removed since the sign-off', () => {
    expect(changesSince([FIN, PAY], [FIN, HR])).toEqual({ added: ['SG-HR'], removed: ['SG-Payroll'] });
  });

  it('is empty when nothing changed, whatever the order', () => {
    expect(changesSince([FIN, PAY], [PAY, FIN])).toEqual({ added: [], removed: [] });
    expect(changesSince()).toEqual({ added: [], removed: [] });
  });
});

describe('reviewSummary', () => {
  it('takes the newest sign-off, not the newest note', () => {
    const note = { id: 'r3', signedOff: false, notes: 'one question', composition: [FIN] };
    const signed = { id: 'r2', signedOff: true, notes: '', composition: [FIN, PAY] };
    const older = { id: 'r1', signedOff: true, notes: '', composition: [] };
    const out = reviewSummary([note, signed, older], [FIN]);
    expect(out.reviews).toHaveLength(3);
    expect(out.current).toBe(1);
    expect(out.latestSignOff.id).toBe('r2');
    expect(out.latestSignOff.changesSince).toEqual({ added: [], removed: ['SG-Payroll'] });
  });

  it('has no sign-off while nobody signed it off', () => {
    expect(reviewSummary([{ id: 'r1', signedOff: false, composition: [] }], []).latestSignOff).toBeNull();
  });
});

describe('the statements', () => {
  it('reads the live contained resources of one role', () => {
    expect(CURRENT_COMPOSITION_SQL).toContain(`rrs."parentResourceId" = $1 AND rrs."relationshipType" = 'Contains'`);
    expect(CURRENT_COMPOSITION_SQL).toContain('r."deletedAt" IS NULL');
  });

  it('reads the newest reviews of one role, at most a page', () => {
    expect(REVIEWS_SQL).toContain('WHERE "resourceId" = $1');
    expect(REVIEWS_SQL).toContain('ORDER BY "reviewedAt" DESC');
    expect(REVIEWS_SQL).toContain(`LIMIT ${HISTORY_LIMIT}`);
  });
});

describe('loading and saving', () => {
  it('loads the reviews and the current composition of the role', async () => {
    const query = vi.fn(async (sql) => ({ rows: sql === REVIEWS_SQL ? [{ id: 'r1', signedOff: true, composition: [FIN] }] : [FIN, PAY] }));
    const out = await loadCompositionReviews('role-1', { query });
    expect(query).toHaveBeenCalledWith(REVIEWS_SQL, ['role-1']);
    expect(query).toHaveBeenCalledWith(CURRENT_COMPOSITION_SQL, ['role-1']);
    expect(out.latestSignOff.changesSince).toEqual({ added: ['SG-Payroll'], removed: [] });
  });

  it('saves who reviewed and what the role contains right now', async () => {
    const query = vi.fn(async (sql) => (sql === CURRENT_COMPOSITION_SQL ? { rows: [FIN] } : { rows: [{ id: 'new' }] }));
    const saved = await saveCompositionReview('role-1', { notes: 'ok', signedOff: true }, { by: 'ann@example.test', byName: 'Ann' }, { query });
    expect(saved).toEqual({ id: 'new' });
    expect(query).toHaveBeenLastCalledWith(INSERT_REVIEW_SQL, ['role-1', 'ok', true, 'ann@example.test', 'Ann', JSON.stringify([FIN])]);
  });

  it('stores no display name when the token has none', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await saveCompositionReview('role-1', { notes: 'ok', signedOff: false }, { by: 'unknown' }, { query });
    expect(query.mock.calls[1][1][4]).toBeNull();
  });
});
