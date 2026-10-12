import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js');
import { query, queryOne } from '../../db/connection.js';
import { reviewMatch, reviewClaim, reviewFinding, KnowledgeReviewError } from './review.js';

const LINK = '11111111-1111-4111-8111-111111111111';
const REL = '22222222-2222-4222-8222-222222222222';
const TARGET = '33333333-3333-4333-8333-333333333333';
const mentionLink = { id: LINK, orgEntityId: 'm1', targetType: 'Identity', targetId: 'x', via: 'mention', orgValue: 'Rob' };

beforeEach(() => { query.mockReset(); queryOne.mockReset(); });

const fails = async (p, status) => {
  const err = await p.catch(e => e);
  expect(err).toBeInstanceOf(KnowledgeReviewError);
  expect(err.httpStatus).toBe(status);
  return err;
};

describe('bulkReviewClaims', () => {
  it('decides only statements that are still proposed, limited to the ids shown', async () => {
    const { bulkReviewClaims } = await import('./review.js');
    query.mockResolvedValueOnce({ rows: [{ id: LINK }, { id: REL }] });
    const out = await bulkReviewClaims(TARGET, { status: 'accepted', ids: [LINK, REL] }, 'wim');
    expect(out).toEqual({ status: 'accepted', updated: 2, ids: [LINK, REL] });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain(`"status" = 'proposed'`);
    expect(sql).toContain(`'bulk', true`);
    expect([params[0], params[1], params[2], params[4]]).toEqual([TARGET, 'accepted', 'wim', [LINK, REL]]);
  });

  it('without ids it means every proposed statement of the transcript; input is checked', async () => {
    const { bulkReviewClaims } = await import('./review.js');
    query.mockResolvedValueOnce({ rows: [] });
    await bulkReviewClaims(TARGET, { status: 'rejected' }, 'wim');
    expect(query.mock.calls[0][1][4]).toBeNull();
    await fails(bulkReviewClaims('x', { status: 'accepted' }, 'wim'), 400);
    await fails(bulkReviewClaims(TARGET, { status: 'proposed' }, 'wim'), 400);
    await fails(bulkReviewClaims(TARGET, { status: 'accepted', ids: ['nope'] }, 'wim'), 400);
  });
});

describe('reviewMatch', () => {
  it('only mention links can be decided here', async () => {
    queryOne.mockResolvedValueOnce(null);
    await fails(reviewMatch(LINK, { action: 'confirm' }, 'wim'), 404);
    expect(queryOne.mock.calls[0][1]).toEqual([LINK, 'mention']);
    await fails(reviewMatch('nope', { action: 'confirm' }, 'wim'), 400);
    await fails(reviewMatch(LINK, { action: 'merge' }, 'wim'), 400);
  });

  it('confirm accepts this candidate and rejects the other open ones of the same type — and nothing else', async () => {
    queryOne.mockResolvedValueOnce(mentionLink);
    query.mockResolvedValueOnce({ rows: [{ ...mentionLink, status: 'accepted' }] }).mockResolvedValueOnce({ rows: [] });
    const r = await reviewMatch(LINK, { action: 'confirm' }, 'wim');
    expect(r.link.status).toBe('accepted');
    expect(query.mock.calls[0][1]).toEqual([LINK, 'wim', 'accepted', 'confirmed']);
    expect(query.mock.calls[1][1]).toEqual(['m1', LINK, 'Identity']);
    expect(query.mock.calls).toHaveLength(2); // no "same value elsewhere" step: another interview's Rob may be another Rob
  });

  it('reject and reset', async () => {
    queryOne.mockResolvedValueOnce(mentionLink).mockResolvedValueOnce({ status: 'rejected' });
    expect((await reviewMatch(LINK, { action: 'reject' }, 'wim')).link.status).toBe('rejected');
    expect(queryOne.mock.calls[1][1]).toEqual([LINK, 'wim', 'rejected', 'rejected']);
    queryOne.mockResolvedValueOnce(mentionLink).mockResolvedValueOnce({ status: 'proposed' });
    await reviewMatch(LINK, { action: 'reset' }, 'wim');
    expect(queryOne.mock.calls[3][0]).toContain('"analystOverride" = NULL');
  });

  it('choose links to an object the reviewer found, which must exist', async () => {
    queryOne.mockResolvedValueOnce(mentionLink).mockResolvedValueOnce(null);
    await fails(reviewMatch(LINK, { action: 'choose', targetType: 'Identity', targetId: TARGET }, 'wim'), 400);
    queryOne.mockResolvedValueOnce(mentionLink);
    await fails(reviewMatch(LINK, { action: 'choose', targetType: 'Planet', targetId: TARGET }, 'wim'), 400);
    queryOne.mockResolvedValueOnce(mentionLink).mockResolvedValueOnce({ id: TARGET });
    query.mockResolvedValueOnce({ rows: [{ id: 'chosen' }] }).mockResolvedValueOnce({ rows: [] });
    const r = await reviewMatch(LINK, { action: 'choose', targetType: 'OrgEntity', targetId: TARGET }, 'wim');
    expect(r.link.id).toBe('chosen');
    expect(query.mock.calls[0][1].slice(1)).toEqual(['wim', 'm1', 'OrgEntity', TARGET, 'mention', 'Rob']);
    expect(query.mock.calls[1][1]).toEqual(['m1', 'chosen']);
  });
});

describe('chooseForMention', () => {
  const MENTION = '44444444-4444-4444-8444-444444444444';

  it('links a mention without candidates to an object the reviewer found', async () => {
    queryOne.mockResolvedValueOnce({ id: MENTION, displayName: 'Wingtip' }).mockResolvedValueOnce({ id: TARGET });
    query.mockResolvedValueOnce({ rows: [{ id: 'chosen', status: 'accepted' }] }).mockResolvedValueOnce({ rows: [] });
    const r = await reviewMatch.length; // keep reviewMatch referenced; the call under test follows
    expect(r).toBeGreaterThan(0);
    const { chooseForMention } = await import('./review.js');
    const out = await chooseForMention(MENTION, { targetType: 'OrgEntity', targetId: TARGET }, 'wim');
    expect(out.link.id).toBe('chosen');
    expect(queryOne.mock.calls[0][0]).toContain(`"entityType" LIKE 'Mentioned %'`);
    expect(query.mock.calls[0][1].slice(1)).toEqual(['wim', MENTION, 'OrgEntity', TARGET, 'mention', 'Wingtip']);
  });

  it('refuses an unknown mention, target type or target', async () => {
    const { chooseForMention } = await import('./review.js');
    await fails(chooseForMention('x', {}, 'wim'), 400);
    queryOne.mockResolvedValueOnce(null);
    await fails(chooseForMention(MENTION, { targetType: 'OrgEntity', targetId: TARGET }, 'wim'), 404);
    queryOne.mockResolvedValueOnce({ id: MENTION });
    await fails(chooseForMention(MENTION, { targetType: 'Planet', targetId: TARGET }, 'wim'), 400);
    queryOne.mockResolvedValueOnce({ id: MENTION }).mockResolvedValueOnce(null);
    await fails(chooseForMention(MENTION, { targetType: 'Identity', targetId: TARGET }, 'wim'), 400);
  });
});

describe('reviewClaim', () => {
  const row = { id: REL, status: 'proposed', predicate: 'memberOf', attributes: { claimKey: 'k', qualifier: null, rejectedBy: 'verifier' } };

  it('validates input', async () => {
    await fails(reviewClaim('x', { status: 'accepted' }, 'wim'), 400);
    await fails(reviewClaim(REL, { status: 'maybe' }, 'wim'), 400);
    await fails(reviewClaim(REL, { status: 'accepted', predicate: 'likes' }, 'wim'), 400);
    await fails(reviewClaim(REL, { status: 'accepted', qualifier: 'x'.repeat(61) }, 'wim'), 400);
  });

  it('answers 409 when someone else decided first', async () => {
    query.mockResolvedValueOnce({ rows: [{ ...row, status: 'accepted' }] });
    const err = await fails(reviewClaim(REL, { status: 'rejected', expectedStatus: 'proposed' }, 'bob'), 409);
    expect(err.message).toContain('"accepted"');
    expect(query.mock.calls[0][0]).toContain('FOR UPDATE');
  });

  it('accepting records who and when, clears a verifier rejection, and keeps the original of an edit', async () => {
    query.mockResolvedValueOnce({ rows: [row] }).mockImplementationOnce(async (_sql, params) => ({
      rows: [{ id: params[0], status: params[1], predicate: params[2], attributes: JSON.parse(params[3]) }],
    }));
    const r = await reviewClaim(REL, { status: 'accepted', expectedStatus: 'proposed', predicate: 'leads', qualifier: 'sinds 2024' }, 'wim');
    expect(r).toMatchObject({ status: 'accepted', predicate: 'leads', qualifier: 'sinds 2024' });
    expect(r.edited).toMatchObject({ by: 'wim', from: { predicate: 'memberOf', qualifier: null } });
    const attrs = JSON.parse(query.mock.calls[1][1][3]);
    expect(attrs.reviewedBy).toBe('wim');
    expect(attrs.rejectedBy).toBeUndefined();
    expect(attrs.claimKey).toBe('k');
  });

  it('a decision without edits records no edit', async () => {
    query.mockResolvedValueOnce({ rows: [row] }).mockImplementationOnce(async (_s, p) => ({ rows: [{ id: p[0], status: p[1], predicate: p[2], attributes: JSON.parse(p[3]) }] }));
    const r = await reviewClaim(REL, { status: 'rejected' }, 'wim');
    expect(r.edited).toBeNull();
    expect(JSON.parse(query.mock.calls[1][1][3]).rejectedBy).toBe('verifier');
  });

  it('unknown statement → 404', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await fails(reviewClaim(REL, { status: 'accepted' }, 'wim'), 404);
  });
});

describe('reviewFinding', () => {
  it('sets the status and who decided; reopening clears the decider', async () => {
    queryOne.mockResolvedValueOnce({ id: REL, status: 'dismissed' }).mockResolvedValueOnce({ id: REL, status: 'open' });
    await reviewFinding(REL, { status: 'dismissed' }, 'wim');
    expect(queryOne.mock.calls[0][1]).toEqual([REL, 'dismissed', 'wim']);
    await reviewFinding(REL, { status: 'open' }, 'wim');
    expect(queryOne.mock.calls[1][1]).toEqual([REL, 'open', null]);
    await fails(reviewFinding(REL, { status: 'gone' }, 'wim'), 400);
    queryOne.mockResolvedValueOnce(null);
    await fails(reviewFinding(REL, { status: 'resolved' }, 'wim'), 404);
  });
});
