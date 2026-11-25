import { describe, it, expect, vi } from 'vitest';
import {
  parseReviewBody, reviewSummary, loadCompositionReviews, saveCompositionReview,
  REVIEWS_SQL, INSERT_REVIEW_SQL, MAX_NOTES, HISTORY_LIMIT,
} from './businessRoleCompositionReview.js';

const FIN = { id: 'g1', displayName: 'SG-Finance' };
const PAY = { id: 'g2', displayName: 'SG-Payroll' };
const picture = (resources, control = 'Manual') => ({ version: 1, type: { control }, resources, policies: [] });

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

describe('reviewSummary', () => {
  it('compares the newest sign-off, not the newest note, with the role now', () => {
    const note = { id: 'r3', signedOff: false, notes: 'one question', snapshot: picture([FIN]) };
    const signed = { id: 'r2', signedOff: true, notes: '', snapshot: picture([FIN, PAY]) };
    const older = { id: 'r1', signedOff: true, notes: '', snapshot: picture([]) };
    const now = picture([FIN], 'Automatic');
    const out = reviewSummary([note, signed, older], now);
    expect(out.reviews).toHaveLength(3);
    expect(out.current).toBe(now);
    expect(out.latestSignOff.id).toBe('r2');
    expect(out.latestSignOff.changesSince).toEqual({ added: [], removed: ['SG-Payroll'], type: { from: 'Manual', to: 'Automatic' }, policiesChanged: false });
  });

  it('has no sign-off while nobody signed it off', () => {
    expect(reviewSummary([{ id: 'r1', signedOff: false, snapshot: picture([]) }], picture([])).latestSignOff).toBeNull();
  });
});

describe('the statements', () => {
  it('reads the newest reviews of one role, at most a page, with their snapshots', () => {
    expect(REVIEWS_SQL).toContain('WHERE "resourceId" = $1');
    expect(REVIEWS_SQL).toContain('ORDER BY "reviewedAt" DESC');
    expect(REVIEWS_SQL).toContain(`LIMIT ${HISTORY_LIMIT}`);
    expect(REVIEWS_SQL).toContain('snapshot');
  });
});

describe('loading and saving', () => {
  it('loads the reviews and a picture of the role now', async () => {
    const query = vi.fn(async () => ({ rows: [{ id: 'r1', signedOff: true, snapshot: picture([FIN]) }] }));
    const snapshot = vi.fn(async () => picture([FIN, PAY]));
    const out = await loadCompositionReviews('role-1', { pool: { query }, snapshot });
    expect(query).toHaveBeenCalledWith(REVIEWS_SQL, ['role-1']);
    expect(snapshot).toHaveBeenCalledWith('role-1');
    expect(out.latestSignOff.changesSince.added).toEqual(['SG-Payroll']);
  });

  it('saves who reviewed with a picture of the role right now', async () => {
    const query = vi.fn(async () => ({ rows: [{ id: 'new' }] }));
    const snapshot = vi.fn(async () => picture([FIN]));
    const saved = await saveCompositionReview('role-1', { notes: 'ok', signedOff: true }, { by: 'ann@example.test', byName: 'Ann' }, { pool: { query }, snapshot });
    expect(saved).toEqual({ id: 'new' });
    expect(query).toHaveBeenCalledWith(INSERT_REVIEW_SQL, ['role-1', 'ok', true, 'ann@example.test', 'Ann', JSON.stringify(picture([FIN]))]);
  });

  it('stores no display name when the token has none', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await saveCompositionReview('role-1', { notes: 'ok', signedOff: false }, { by: 'unknown' }, { pool: { query }, snapshot: async () => picture([]) });
    expect(query.mock.calls[0][1][4]).toBeNull();
  });
});
