import { describe, it, expect, vi } from 'vitest';
import {
  parseCampaignBody, ensureRounds, openRequestsFor, answerRequests, requestStatus, presentCampaign,
  listCampaigns, loadCampaign, createCampaign, endCampaign, deleteCampaign, scopeOptions,
  RUNNING_SQL, INSERT_ROUND_SQL, INSERT_REQUESTS_SQL, MY_REQUESTS_SQL, ANSWER_REQUESTS_SQL, CAMPAIGNS_SQL,
  ROUND_REQUESTS_SQL, SCOPE_SQL, LATEST_ROUND_SQL, INSERT_CAMPAIGN_SQL, INSERT_ROLE_SCOPE_SQL, INSERT_PORTFOLIO_SCOPE_SQL,
  SCOPE_ROLES_SQL, SCOPE_PORTFOLIOS_SQL, MAX_NAME, MAX_SCOPE,
} from './reviewCampaigns.js';

const ROLE = 'aaaaaaaa-0000-4000-8000-000000000001';
const ROLE2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const PORTFOLIO = 'bbbbbbbb-0000-4000-8000-000000000001';
const BODY = { name: ' Yearly role review ', steps: ['contents', 'ownership'], roleIds: [ROLE], portfolioIds: [PORTFOLIO], startsOn: '2026-12-01', intervalMonths: 12, dueDays: 30 };
const noEnsure = async () => 0;

describe('parseCampaignBody', () => {
  it('keeps a trimmed name, the steps in their fixed order, the scope and the schedule', () => {
    expect(parseCampaignBody(BODY)).toEqual({
      name: 'Yearly role review', steps: ['ownership', 'contents'], roleIds: [ROLE], portfolioIds: [PORTFOLIO],
      startsOn: '2026-12-01', intervalMonths: 12, dueDays: 30,
    });
  });

  it('reads no interval as asking once, and lists an id once whatever its case', () => {
    const out = parseCampaignBody({ ...BODY, intervalMonths: undefined, roleIds: [ROLE, ROLE.toUpperCase(), ROLE2], portfolioIds: undefined });
    expect(out.intervalMonths).toBeNull();
    expect(out.roleIds).toEqual([ROLE, ROLE2]);
    expect(out.portfolioIds).toEqual([]);
  });

  it('wants a name, of a sensible length', () => {
    expect(parseCampaignBody({ ...BODY, name: '   ' })).toEqual({ error: 'Give the campaign a name' });
    expect(parseCampaignBody({ ...BODY, name: 7 })).toEqual({ error: 'Give the campaign a name' });
    expect(parseCampaignBody(undefined)).toEqual({ error: 'Give the campaign a name' });
    expect(parseCampaignBody({ ...BODY, name: 'a'.repeat(MAX_NAME) }).name).toHaveLength(MAX_NAME);
    expect(parseCampaignBody({ ...BODY, name: 'a'.repeat(MAX_NAME + 1) })).toEqual({ error: `The name can be at most ${MAX_NAME} characters` });
  });

  it('wants at least one known step', () => {
    expect(parseCampaignBody({ ...BODY, steps: [] })).toEqual({ error: 'Choose at least one step to review' });
    expect(parseCampaignBody({ ...BODY, steps: 'contents' })).toEqual({ error: 'Choose at least one step to review' });
    expect(parseCampaignBody({ ...BODY, steps: ['contents', 'holders'] }).error).toMatch(/^Unknown step/);
  });

  it('wants a scope of ids, not empty and not endless', () => {
    expect(parseCampaignBody({ ...BODY, roleIds: [], portfolioIds: [] })).toEqual({ error: 'Choose at least one business role or role portfolio' });
    expect(parseCampaignBody({ ...BODY, roleIds: ['Finance'] })).toEqual({ error: 'The business roles must be a list of ids' });
    expect(parseCampaignBody({ ...BODY, roleIds: ROLE })).toEqual({ error: 'The business roles must be a list of ids' });
    expect(parseCampaignBody({ ...BODY, portfolioIds: [42] })).toEqual({ error: 'The role portfolios must be a list of ids' });
    const many = (n) => Array.from({ length: n }, (_, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(parseCampaignBody({ ...BODY, roleIds: many(MAX_SCOPE - 1) }).roleIds).toHaveLength(MAX_SCOPE - 1);
    expect(parseCampaignBody({ ...BODY, roleIds: many(MAX_SCOPE) })).toEqual({ error: `Choose at most ${MAX_SCOPE} roles and portfolios` });
  });

  it('wants a real start day, a known interval and a term within a year', () => {
    expect(parseCampaignBody({ ...BODY, startsOn: '2026-02-30' })).toEqual({ error: 'The start date must be a day, as YYYY-MM-DD' });
    expect(parseCampaignBody({ ...BODY, intervalMonths: 2 }).error).toMatch(/^Repeat every 1, 3, 6, 12 months/);
    expect(parseCampaignBody({ ...BODY, intervalMonths: '12' }).error).toMatch(/^Repeat every/);
    const term = { error: 'Give people between 1 and 365 days to review' };
    expect(parseCampaignBody({ ...BODY, dueDays: 0 })).toEqual(term);
    expect(parseCampaignBody({ ...BODY, dueDays: 366 })).toEqual(term);
    expect(parseCampaignBody({ ...BODY, dueDays: 1.5 })).toEqual(term);
    expect(parseCampaignBody({ ...BODY, dueDays: '30' })).toEqual(term);
    expect(parseCampaignBody({ ...BODY, dueDays: 1 }).dueDays).toBe(1);
    expect(parseCampaignBody({ ...BODY, dueDays: 365 }).dueDays).toBe(365);
  });
});

describe('ensureRounds', () => {
  function world(campaigns, { taken = false } = {}) {
    const written = [];
    const pool = { query: vi.fn(async () => ({ rows: campaigns })) };
    const client = { query: vi.fn(async (sql, params) => { written.push([sql, params]); return { rows: sql === INSERT_ROUND_SQL && !taken ? [{ id: 'round-new' }] : [] }; }) };
    const tx = vi.fn(async (fn) => fn(client));
    return { written, pool, tx, opts: { pool, tx, now: () => new Date('2027-03-01T08:00:00Z') } };
  }
  const quarterly = { id: 'c1', startsOn: '2026-12-01', intervalMonths: 3, dueDays: 30, lastRound: 1 };

  it('asks for the campaigns running today', async () => {
    const w = world([]);
    expect(await ensureRounds(w.opts)).toBe(0);
    expect(w.pool.query).toHaveBeenCalledWith(RUNNING_SQL, ['2027-03-01']);
    expect(w.tx).not.toHaveBeenCalled();
  });

  it('makes the round a campaign should be in, with a request per role in scope', async () => {
    const w = world([quarterly]);
    expect(await ensureRounds(w.opts)).toBe(1);
    expect(w.written).toEqual([
      [INSERT_ROUND_SQL, ['c1', 2, '2027-03-01', '2027-03-31']],
      [INSERT_REQUESTS_SQL, ['round-new', 'c1']],
    ]);
  });

  it('makes nothing for a campaign that is in its round already', async () => {
    const w = world([{ ...quarterly, lastRound: 2 }, { ...quarterly, id: 'c2', lastRound: '2' }]);
    expect(await ensureRounds(w.opts)).toBe(0);
    expect(w.tx).not.toHaveBeenCalled();
  });

  it('starts a campaign whose first day has come, and skips the rounds nobody looked at', async () => {
    const w = world([{ id: 'c3', startsOn: '2027-03-01', intervalMonths: null, dueDays: 7, lastRound: 0 }, { ...quarterly, id: 'c4', startsOn: '2026-03-01', lastRound: 1 }]);
    expect(await ensureRounds(w.opts)).toBe(2);
    expect(w.written[0]).toEqual([INSERT_ROUND_SQL, ['c3', 1, '2027-03-01', '2027-03-08']]);
    expect(w.written[2]).toEqual([INSERT_ROUND_SQL, ['c4', 5, '2027-03-01', '2027-03-31']]);
  });

  it('adds no requests when another caller made the round first', async () => {
    const w = world([quarterly], { taken: true });
    expect(await ensureRounds(w.opts)).toBe(0);
    expect(w.written.map(([sql]) => sql)).toEqual([INSERT_ROUND_SQL]);
  });
});

describe('the statements', () => {
  it('runs only campaigns that have not ended and have started', () => {
    expect(RUNNING_SQL).toContain(`c."endedAt" IS NULL AND c."startsOn" <= $1::date`);
  });

  it('makes a round once and due at the end of its last day', () => {
    expect(INSERT_ROUND_SQL).toContain('ON CONFLICT ("campaignId", number) DO NOTHING');
    expect(INSERT_ROUND_SQL).toContain(`$4::date + interval '1 day' - interval '1 second'`);
  });

  it('asks about live business roles only: named by themselves, or members of a portfolio in scope', () => {
    expect(INSERT_REQUESTS_SQL).toContain(`r."resourceType" = 'BusinessRole' AND r."deletedAt" IS NULL`);
    expect(INSERT_REQUESTS_SQL).toContain('s."resourceId" IS NOT NULL');
    expect(INSERT_REQUESTS_SQL).toContain(`cm."contextId" = s."contextId" AND cm."memberType" = 'Resource'`);
    expect(INSERT_REQUESTS_SQL).toContain('ON CONFLICT ("roundId", "resourceId") DO NOTHING');
  });

  it('counts a request as open only unanswered, in the newest round of a running campaign', () => {
    for (const sql of [MY_REQUESTS_SQL, ANSWER_REQUESTS_SQL]) {
      expect(sql).toContain('q."reviewId" IS NULL AND c."endedAt" IS NULL');
      expect(sql).toContain('rd.number = (SELECT max(x.number) FROM "ReviewCampaignRounds" x WHERE x."campaignId" = c.id)');
    }
  });

  it('asks the Accountable, through any of the person\'s accounts', () => {
    for (const sql of [MY_REQUESTS_SQL, ANSWER_REQUESTS_SQL]) {
      expect(sql).toContain(`o."resourceId" = q."resourceId" AND o.role = 'Accountable'`);
      expect(sql).toContain('o."principalId" = $1::uuid');
      expect(sql).toContain('o."identityId" = $2::uuid');
      expect(sql).toContain('FROM "IdentityMembers" m WHERE m."identityId" = $2::uuid');
    }
  });

  it('lists what a person is asked soonest due first, leaving out a deleted role', () => {
    expect(MY_REQUESTS_SQL).toContain('r."deletedAt" IS NULL');
    expect(MY_REQUESTS_SQL).toContain('($3::uuid IS NULL OR q."resourceId" = $3::uuid)');
    expect(MY_REQUESTS_SQL).toContain('ORDER BY rd."dueAt"');
  });

  it('answers only requests whose campaign asked no step the review left out', () => {
    expect(ANSWER_REQUESTS_SQL).toContain('c.steps <@ $5::jsonb');
    expect(ANSWER_REQUESTS_SQL).toContain('q."resourceId" = $3::uuid');
    expect(ANSWER_REQUESTS_SQL).toContain('SET "reviewId" = $4::uuid');
  });

  it('counts a role with nobody Accountable apart from one that waits', () => {
    expect(CAMPAIGNS_SQL).toMatch(/q\."reviewId" IS NULL AND NOT EXISTS \(\s+SELECT 1 FROM "BusinessRoleOwners" o WHERE o\."resourceId" = q\."resourceId" AND o\.role = 'Accountable'\)\)\)::int AS "noAccountable"/);
    expect(CAMPAIGNS_SQL).toMatch(/q\."reviewId" IS NULL AND EXISTS \(\s+SELECT 1 FROM "BusinessRoleOwners" o WHERE o\."resourceId" = q\."resourceId" AND o\.role = 'Accountable'\)\)\)::int AS waiting/);
    expect(CAMPAIGNS_SQL).toContain(`s.verdict <> 'good'`);
  });

  it('takes only existing business roles and role portfolios into a scope', () => {
    expect(INSERT_ROLE_SCOPE_SQL).toContain(`r."resourceType" = 'BusinessRole' AND r."deletedAt" IS NULL`);
    expect(INSERT_PORTFOLIO_SCOPE_SQL).toContain(`x."contextCategory" = 'Catalog'`);
    expect(SCOPE_ROLES_SQL).toContain('AS "hasAccountable"');
    expect(SCOPE_PORTFOLIOS_SQL).toContain(`x."contextCategory" = 'Catalog'`);
  });
});

describe('openRequestsFor', () => {
  const me = { principal: { id: 'p-1' }, identity: { id: 'i-1' } };

  it('makes the rounds that are due, then lists the person\'s requests', async () => {
    const order = [];
    const pool = { query: vi.fn(async () => { order.push('query'); return { rows: [{ id: 'q-1' }] }; }) };
    const ensure = vi.fn(async () => { order.push('ensure'); });
    expect(await openRequestsFor(me, ROLE, { pool, ensure })).toEqual([{ id: 'q-1' }]);
    expect(order).toEqual(['ensure', 'query']);
    expect(pool.query).toHaveBeenCalledWith(MY_REQUESTS_SQL, ['p-1', 'i-1', ROLE]);
  });

  it('asks for every role, and for someone without a person behind the account', async () => {
    const pool = { query: vi.fn(async () => ({ rows: [] })) };
    await openRequestsFor({ principal: { id: 'p-1' }, identity: null }, undefined, { pool, ensure: noEnsure });
    expect(pool.query).toHaveBeenCalledWith(MY_REQUESTS_SQL, ['p-1', null, null]);
  });

  it('is nothing for someone we do not know, without touching the database', async () => {
    const pool = { query: vi.fn() };
    const ensure = vi.fn();
    expect(await openRequestsFor(null, ROLE, { pool, ensure })).toEqual([]);
    expect(await openRequestsFor({ principal: null }, ROLE, { pool, ensure })).toEqual([]);
    expect(pool.query).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
  });
});

describe('answerRequests', () => {
  const review = { id: 'rev-1', steps: [{ step: 'ownership' }, { step: 'contents' }] };

  it('marks the person\'s open requests for the role with the review and the steps it judged', async () => {
    const pool = { query: vi.fn(async () => ({ rows: [{ id: 'q-1' }, { id: 'q-2' }] })) };
    expect(await answerRequests({ principal: { id: 'p-1' }, identity: { id: 'i-1' } }, ROLE, review, { pool })).toBe(2);
    expect(pool.query).toHaveBeenCalledWith(ANSWER_REQUESTS_SQL, ['p-1', 'i-1', ROLE, 'rev-1', '["ownership","contents"]']);
  });

  it('answers nothing for someone we do not know', async () => {
    const pool = { query: vi.fn() };
    expect(await answerRequests(null, ROLE, review, { pool })).toBe(0);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('passes no identity for an account without a person', async () => {
    const pool = { query: vi.fn(async () => ({ rows: [] })) };
    expect(await answerRequests({ principal: { id: 'p-1' } }, ROLE, review, { pool })).toBe(0);
    expect(pool.query.mock.calls[0][1][1]).toBeNull();
  });
});

describe('requestStatus', () => {
  const now = new Date('2026-12-10T12:00:00Z');
  const due = '2026-12-15T23:59:59Z';

  it('is reviewed, with or without findings, whoever is Accountable now', () => {
    expect(requestStatus({ reviewId: 'r', findings: 0, accountable: null }, due, now)).toBe('noFindings');
    expect(requestStatus({ reviewId: 'r', findings: 2, accountable: 'Ann' }, '2026-12-01T00:00:00Z', now)).toBe('findings');
  });

  it('has nobody to ask before it is late or waiting', () => {
    expect(requestStatus({ reviewId: null, accountable: null }, '2026-12-01T00:00:00Z', now)).toBe('noAccountable');
    expect(requestStatus({ reviewId: null, accountable: '' }, due, now)).toBe('noAccountable');
  });

  it('waits until the round is due, then is late', () => {
    expect(requestStatus({ reviewId: null, accountable: 'Ann' }, due, now)).toBe('waiting');
    expect(requestStatus({ reviewId: null, accountable: 'Ann' }, '2026-12-10T11:59:59Z', now)).toBe('overdue');
  });
});

describe('presentCampaign', () => {
  const now = new Date('2026-12-10T12:00:00Z');
  const row = {
    id: 'c1', name: 'Yearly', steps: ['contents'], startsOn: '2026-12-01', intervalMonths: 3, dueDays: 30, endedAt: null,
    roundNumber: 1, roundStartsAt: '2026-12-01T00:00:00Z', roundDueAt: '2026-12-31T23:59:59Z',
    total: 5, reviewed: 2, findings: 1, noAccountable: 1, waiting: 2,
  };

  it('gives a running campaign its round, how it stands and when it asks again', () => {
    expect(presentCampaign(row, now)).toEqual({
      id: 'c1', name: 'Yearly', steps: ['contents'], startsOn: '2026-12-01', intervalMonths: 3, dueDays: 30, endedAt: null,
      status: 'running', nextRoundOn: '2027-03-01',
      round: { number: 1, startsAt: '2026-12-01T00:00:00Z', dueAt: '2026-12-31T23:59:59Z', overdue: false, total: 5, reviewed: 2, findings: 1, noAccountable: 1, waiting: 2 },
    });
  });

  it('says when the round is past due, and that a campaign asking once has no next round', () => {
    const out = presentCampaign({ ...row, intervalMonths: null }, new Date('2027-01-01T00:00:00Z'));
    expect(out.round.overdue).toBe(true);
    expect(out.nextRoundOn).toBeNull();
  });

  it('is planned until its first day, which is when it asks first', () => {
    const out = presentCampaign({ ...row, startsOn: '2027-01-01', roundNumber: null, roundStartsAt: null, roundDueAt: null }, now);
    expect(out).toMatchObject({ status: 'planned', round: null, nextRoundOn: '2027-01-01' });
  });

  it('is ended once stopped, with no next round', () => {
    expect(presentCampaign({ ...row, endedAt: '2026-12-05T00:00:00Z' }, now)).toMatchObject({ status: 'ended', nextRoundOn: null });
    expect(presentCampaign({ ...row, endedAt: '2026-12-05T00:00:00Z', roundNumber: null }, now)).toMatchObject({ status: 'ended', round: null, nextRoundOn: null });
  });
});

describe('listing and loading', () => {
  const campaignRow = { id: 'c1', name: 'Yearly', startsOn: '2026-12-01', intervalMonths: null, dueDays: 30, endedAt: null, roundNumber: 1, roundStartsAt: '2026-12-01T00:00:00Z', roundDueAt: '2026-12-31T23:59:59Z', total: 2, reviewed: 1, findings: 0, noAccountable: 1, waiting: 0 };
  const now = () => new Date('2026-12-10T12:00:00Z');

  it('lists every campaign after making the rounds that are due', async () => {
    const ensure = vi.fn(async () => 0);
    const pool = { query: vi.fn(async () => ({ rows: [campaignRow] })) };
    const out = await listCampaigns({ pool, ensure, now });
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(pool.query).toHaveBeenCalledWith(CAMPAIGNS_SQL, [null]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'c1', status: 'running', round: { number: 1, total: 2 } });
  });

  it('loads one campaign with its scope and how each role of its newest round stands', async () => {
    const pool = { query: vi.fn(async (sql) => {
      if (sql === CAMPAIGNS_SQL) return { rows: [campaignRow] };
      if (sql === SCOPE_SQL) return { rows: [{ resourceId: null, contextId: PORTFOLIO, displayName: 'Finance roles' }, { resourceId: ROLE, contextId: null, displayName: 'Controller' }] };
      if (sql === LATEST_ROUND_SQL) return { rows: [{ id: 'round-1', dueAt: '2026-12-31T23:59:59Z' }] };
      if (sql === ROUND_REQUESTS_SQL) return { rows: [{ id: 'q-1', roleId: ROLE, accountable: 'Ann', reviewId: 'rev-1', findings: 0 }, { id: 'q-2', roleId: ROLE2, accountable: null, reviewId: null }] };
      throw new Error('unexpected query');
    }) };
    const out = await loadCampaign('c1', { pool, ensure: noEnsure, now });
    expect(pool.query).toHaveBeenCalledWith(CAMPAIGNS_SQL, ['c1']);
    expect(pool.query).toHaveBeenCalledWith(ROUND_REQUESTS_SQL, ['round-1']);
    expect(out.scope).toEqual({ roles: [{ id: ROLE, displayName: 'Controller' }], portfolios: [{ id: PORTFOLIO, displayName: 'Finance roles' }] });
    expect(out.requests.map(r => [r.id, r.status])).toEqual([['q-1', 'noFindings'], ['q-2', 'noAccountable']]);
  });

  it('has no requests for a campaign that has not asked yet', async () => {
    const pool = { query: vi.fn(async (sql) => (sql === CAMPAIGNS_SQL ? { rows: [{ ...campaignRow, roundNumber: null }] } : { rows: [] })) };
    const out = await loadCampaign('c1', { pool, ensure: noEnsure, now });
    expect(out.requests).toEqual([]);
    expect(pool.query.mock.calls.some(([sql]) => sql === ROUND_REQUESTS_SQL)).toBe(false);
  });

  it('is null for a campaign that does not exist', async () => {
    const pool = { query: vi.fn(async () => ({ rows: [] })) };
    expect(await loadCampaign('c9', { pool, ensure: noEnsure })).toBeNull();
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

describe('createCampaign', () => {
  const campaign = parseCampaignBody(BODY);
  function world({ roles = 1, portfolios = 1 } = {}) {
    const written = [];
    const client = { query: vi.fn(async (sql, params) => {
      written.push([sql, params]);
      if (sql === INSERT_CAMPAIGN_SQL) return { rows: [{ id: 'c-new' }] };
      return { rowCount: sql === INSERT_ROLE_SCOPE_SQL ? roles : portfolios };
    }) };
    const tx = vi.fn(async (fn) => fn(client));
    const ensure = vi.fn(async () => 1);
    return { written, tx, ensure, opts: { tx, ensure } };
  }

  it('saves the campaign and its scope in one transaction, then makes its first round', async () => {
    const w = world();
    expect(await createCampaign(campaign, 'ann@example.test', w.opts)).toEqual({ id: 'c-new' });
    expect(w.tx).toHaveBeenCalledTimes(1);
    expect(w.written).toEqual([
      [INSERT_CAMPAIGN_SQL, ['Yearly role review', '["ownership","contents"]', '2026-12-01', 12, 30, 'ann@example.test']],
      [INSERT_ROLE_SCOPE_SQL, ['c-new', [ROLE]]],
      [INSERT_PORTFOLIO_SCOPE_SQL, ['c-new', [PORTFOLIO]]],
    ]);
    expect(w.ensure).toHaveBeenCalledTimes(1);
  });

  it('keeps a campaign whose scope is only roles, or only portfolios', async () => {
    expect(await createCampaign(campaign, 'ann', world({ roles: 1, portfolios: 0 }).opts)).toEqual({ id: 'c-new' });
    expect(await createCampaign(campaign, 'ann', world({ roles: 0, portfolios: 1 }).opts)).toEqual({ id: 'c-new' });
  });

  it('refuses a campaign none of whose roles or portfolios exist, and makes no round', async () => {
    const w = world({ roles: 0, portfolios: 0 });
    expect(await createCampaign(campaign, 'ann', w.opts)).toEqual({ error: 'None of the chosen business roles or role portfolios exist any more' });
    expect(w.ensure).not.toHaveBeenCalled();
  });

  it('lets a database failure through', async () => {
    const tx = vi.fn(async () => { throw new Error('down'); });
    await expect(createCampaign(campaign, 'ann', { tx, ensure: noEnsure })).rejects.toThrow('down');
  });
});

describe('ending, removing and choosing', () => {
  it('ends only a campaign that still runs', async () => {
    const pool = { query: vi.fn(async () => ({ rowCount: 1 })) };
    expect(await endCampaign('c1', { pool })).toBe(true);
    expect(pool.query.mock.calls[0][0]).toContain('WHERE id = $1 AND "endedAt" IS NULL');
    expect(await endCampaign('c1', { pool: { query: async () => ({ rowCount: 0 }) } })).toBe(false);
  });

  it('removes a campaign, and says when there was none', async () => {
    const pool = { query: vi.fn(async () => ({ rowCount: 1 })) };
    expect(await deleteCampaign('c1', { pool })).toBe(true);
    expect(pool.query).toHaveBeenCalledWith('DELETE FROM "ReviewCampaigns" WHERE id = $1', ['c1']);
    expect(await deleteCampaign('c1', { pool: { query: async () => ({ rowCount: 0 }) } })).toBe(false);
  });

  it('offers every business role and role portfolio to choose from', async () => {
    const pool = { query: vi.fn(async (sql) => ({ rows: sql === SCOPE_ROLES_SQL ? [{ id: ROLE }] : [{ id: PORTFOLIO }] })) };
    expect(await scopeOptions({ pool })).toEqual({ roles: [{ id: ROLE }], portfolios: [{ id: PORTFOLIO }] });
  });
});
