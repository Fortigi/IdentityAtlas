import { describe, it, expect, vi } from 'vitest';
import {
  reviewSummary, presentReview, loadCompositionReviews, saveCompositionReview, resolveProposal, searchPeople,
  REVIEWS_SQL, INSERT_REVIEW_SQL, INSERT_STEP_SQL, PRINCIPAL_NAMES_SQL, IDENTITY_NAMES_SQL, PEOPLE_SQL,
  HISTORY_LIMIT, PEOPLE_LIMIT,
} from './businessRoleCompositionReview.js';

const ANN = 'aaaaaaaa-0000-4000-8000-000000000001';
const BOB = 'bbbbbbbb-0000-4000-8000-000000000002';
const CARLA = 'cccccccc-0000-4000-8000-000000000003';
const FIN = { id: 'g1', displayName: 'SG-Finance' };
const PAY = { id: 'g2', displayName: 'SG-Payroll' };
const picture = (resources, owners = []) => ({ version: 2, type: { control: 'Manual' }, resources, policies: [], owners });
const step = (name, verdict = 'good', remark = '', proposal = null) => ({ step: name, verdict, remark, proposal });

describe('presentReview', () => {
  it('orders the stored steps and says what the review found', () => {
    const out = presentReview({ id: 'r1', steps: [step('contents', 'needsChange', 'x'), step('ownership')] });
    expect(out.steps.map(s => s.step)).toEqual(['ownership', 'contents']);
    expect(out.outcome).toBe('findings');
    expect(presentReview({ id: 'r2', steps: [step('contents')] }).outcome).toBe('noFindings');
  });

  it('copes with a row that has no steps', () => {
    expect(presentReview({ id: 'r3' })).toEqual({ id: 'r3', steps: [], outcome: 'noFindings' });
  });
});

describe('reviewSummary', () => {
  it('compares the newest review, findings or not, with the role now', () => {
    const newest = { id: 'r2', steps: [step('contents', 'notUnderstood')], snapshot: picture([FIN, PAY]) };
    const older = { id: 'r1', steps: [step('contents')], snapshot: picture([]) };
    const now = picture([FIN]);
    const out = reviewSummary([newest, older], now);
    expect(out.reviews.map(r => [r.id, r.outcome])).toEqual([['r2', 'findings'], ['r1', 'noFindings']]);
    expect(out.current).toBe(now);
    expect(out.latestReview).toMatchObject({ id: 'r2', outcome: 'findings', changesSince: { added: [], removed: ['SG-Payroll'] } });
  });

  it('has no latest review while nobody reviewed the role, and always names the steps and verdicts', () => {
    const out = reviewSummary([], picture([]));
    expect(out.latestReview).toBeNull();
    expect(out.steps).toEqual(['ownership', 'lifecycle', 'contents']);
    expect(out.verdicts).toEqual(['good', 'needsChange', 'notUnderstood']);
  });
});

describe('the statements', () => {
  it('reads the newest reviews of one role, at most a page, each with its steps', () => {
    expect(REVIEWS_SQL).toContain('WHERE r."resourceId" = $1');
    expect(REVIEWS_SQL).toContain('ORDER BY r."reviewedAt" DESC');
    expect(REVIEWS_SQL).toContain(`LIMIT ${HISTORY_LIMIT}`);
    expect(REVIEWS_SQL).toContain('WHERE s."reviewId" = r.id');
    expect(REVIEWS_SQL).toContain(`'[]'::jsonb) AS steps`);
  });

  it('names only live accounts and existing persons', () => {
    expect(PRINCIPAL_NAMES_SQL).toContain('"deletedAt" IS NULL');
    expect(PRINCIPAL_NAMES_SQL).toContain('FROM "Principals"');
    expect(IDENTITY_NAMES_SQL).toContain('FROM "Identities"');
  });

  it('finds live user accounts by name or e-mail, a short list, with nothing but who they are', () => {
    expect(PEOPLE_SQL).toContain(`u."deletedAt" IS NULL AND u."principalType" = 'User'`);
    expect(PEOPLE_SQL).toContain(`u."displayName" ILIKE $1 ESCAPE '\\'`);
    expect(PEOPLE_SQL).toContain(`u.email ILIKE $1 ESCAPE '\\'`);
    expect(PEOPLE_SQL).toContain(`LIMIT ${PEOPLE_LIMIT}`);
    expect(PEOPLE_SQL).toMatch(/SELECT u\.id, u\."displayName", u\.email AS "userPrincipalName"\s+FROM/);
  });
});

describe('loadCompositionReviews', () => {
  it('loads the reviews and a picture of the role now', async () => {
    const query = vi.fn(async () => ({ rows: [{ id: 'r1', steps: [step('contents')], snapshot: picture([FIN]) }] }));
    const snapshot = vi.fn(async () => picture([FIN, PAY]));
    const out = await loadCompositionReviews('role-1', { pool: { query }, snapshot });
    expect(query).toHaveBeenCalledWith(REVIEWS_SQL, ['role-1']);
    expect(snapshot).toHaveBeenCalledWith('role-1');
    expect(out.latestReview.changesSince.added).toEqual(['SG-Payroll']);
  });
});

describe('resolveProposal', () => {
  const directory = (principals, identities) => ({
    query: vi.fn(async (sql, [ids]) => {
      const names = sql === PRINCIPAL_NAMES_SQL ? principals : identities;
      return { rows: ids.filter(id => id in names).map(id => ({ id: id.toUpperCase(), displayName: names[id] })) };
    }),
  });

  it('gives every person the name the directory has, accounts and persons each from their own table', async () => {
    const pool = directory({ [ANN]: 'Ann Analyst' }, { [BOB]: 'Bob Builder' });
    const out = await resolveProposal({ accountable: { principalId: ANN }, responsible: [{ identityId: BOB }] }, { pool });
    expect(out).toEqual({ accountable: { principalId: ANN, displayName: 'Ann Analyst' }, responsible: [{ identityId: BOB, displayName: 'Bob Builder' }] });
    expect(pool.query).toHaveBeenCalledWith(PRINCIPAL_NAMES_SQL, [[ANN]]);
    expect(pool.query).toHaveBeenCalledWith(IDENTITY_NAMES_SQL, [[BOB]]);
  });

  it('asks the directory nothing when the proposal names nobody', async () => {
    const pool = directory({}, {});
    expect(await resolveProposal({ accountable: null, responsible: [] }, { pool })).toEqual({ accountable: null, responsible: [] });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('is null when the Accountable or one Responsible is not in the directory', async () => {
    expect(await resolveProposal({ accountable: { principalId: ANN }, responsible: [] }, { pool: directory({}, {}) })).toBeNull();
    expect(await resolveProposal({ accountable: null, responsible: [{ principalId: ANN }, { principalId: CARLA }] }, { pool: directory({ [ANN]: 'Ann' }, {}) })).toBeNull();
    // An account id is not looked for among the persons.
    expect(await resolveProposal({ accountable: { principalId: BOB }, responsible: [] }, { pool: directory({}, { [BOB]: 'Bob' }) })).toBeNull();
  });

  it('keeps someone the directory knows without a name', async () => {
    const out = await resolveProposal({ accountable: { principalId: ANN }, responsible: [] }, { pool: directory({ [ANN]: null }, {}) });
    expect(out.accountable).toEqual({ principalId: ANN, displayName: null });
  });
});

describe('saveCompositionReview', () => {
  const owners = [{ role: 'Accountable', principalId: ANN, displayName: 'Ann' }, { role: 'Responsible', principalId: BOB, displayName: 'Bob' }];
  function world({ names = { [ANN]: 'Ann', [BOB]: 'Bob', [CARLA]: 'Carla Cash' } } = {}) {
    const written = [];
    const client = { query: vi.fn(async (sql, params) => { written.push([sql, params]); return { rows: [{ id: 'new', notes: params[1], reviewedBy: params[2] }] }; }) };
    const pool = { query: vi.fn(async (_sql, [ids]) => ({ rows: ids.filter(id => id in names).map(id => ({ id, displayName: names[id] })) })) };
    const tx = vi.fn(async (fn) => fn(client));
    const snapshot = vi.fn(async () => picture([FIN], owners));
    return { written, pool, tx, snapshot, opts: { pool, tx, snapshot } };
  }
  const who = { by: 'ann@example.test', byName: 'Ann' };

  it('saves the review and one row per step in one transaction, with a picture of the role right now', async () => {
    const w = world();
    const steps = [step('ownership'), step('lifecycle', 'needsChange', 'too wide'), step('contents', 'notUnderstood', 'What is SG-X?')];
    const saved = await saveCompositionReview('role-1', { steps, notes: 'done' }, who, w.opts);
    expect(w.tx).toHaveBeenCalledTimes(1);
    expect(w.written).toEqual([
      [INSERT_REVIEW_SQL, ['role-1', 'done', 'ann@example.test', 'Ann', JSON.stringify(picture([FIN], owners))]],
      [INSERT_STEP_SQL, ['new', 'ownership', 'good', '', null]],
      [INSERT_STEP_SQL, ['new', 'lifecycle', 'needsChange', 'too wide', null]],
      [INSERT_STEP_SQL, ['new', 'contents', 'notUnderstood', 'What is SG-X?', null]],
    ]);
    expect(saved).toMatchObject({ id: 'new', notes: 'done', outcome: 'findings' });
    expect(saved.steps).toEqual(steps);
  });

  it('stores proposed owners with the names the directory has', async () => {
    const w = world();
    const proposal = { accountable: { principalId: CARLA }, responsible: [{ principalId: BOB }] };
    const saved = await saveCompositionReview('role-1', { steps: [step('ownership', 'needsChange', '', proposal)], notes: '' }, who, w.opts);
    const stored = { accountable: { principalId: CARLA, displayName: 'Carla Cash' }, responsible: [{ principalId: BOB, displayName: 'Bob' }] };
    expect(w.written[1]).toEqual([INSERT_STEP_SQL, ['new', 'ownership', 'needsChange', '', JSON.stringify(stored)]]);
    expect(saved.steps[0].proposal).toEqual(stored);
  });

  it('drops a proposal that names the people who answer for the role already, and then wants words', async () => {
    const same = { accountable: { principalId: ANN }, responsible: [{ principalId: BOB }] };
    const quiet = world();
    expect(await saveCompositionReview('role-1', { steps: [step('ownership', 'needsChange', '', same)], notes: '' }, who, quiet.opts))
      .toEqual({ error: 'Say what should change, or choose the people it should be' });
    expect(quiet.tx).not.toHaveBeenCalled();
    expect(quiet.pool.query).not.toHaveBeenCalled();

    const spoken = world();
    const saved = await saveCompositionReview('role-1', { steps: [step('ownership', 'needsChange', 'Ann is leaving', same)], notes: '' }, who, spoken.opts);
    expect(saved.steps[0]).toEqual(step('ownership', 'needsChange', 'Ann is leaving', null));
    expect(spoken.written[1][1][4]).toBeNull();
  });

  it('refuses proposed people the directory does not know, and writes nothing', async () => {
    const w = world({ names: {} });
    const proposal = { accountable: { principalId: CARLA }, responsible: [] };
    expect(await saveCompositionReview('role-1', { steps: [step('ownership', 'needsChange', 'x', proposal)], notes: '' }, who, w.opts))
      .toEqual({ error: 'Choose the people from the list: one of them is not in the directory any more' });
    expect(w.tx).not.toHaveBeenCalled();
  });

  it('refuses a change that says nothing, on any step', async () => {
    const w = world();
    expect((await saveCompositionReview('role-1', { steps: [step('contents', 'needsChange')], notes: '' }, who, w.opts)).error).toMatch(/^Say what should change/);
    expect(w.tx).not.toHaveBeenCalled();
  });

  it('stores no display name when the token has none', async () => {
    const w = world();
    await saveCompositionReview('role-1', { steps: [step('contents')], notes: '' }, { by: 'unknown' }, w.opts);
    expect(w.written[0][1].slice(2, 4)).toEqual(['unknown', null]);
  });
});

describe('searchPeople', () => {
  it('searches for the escaped term as a contains match', async () => {
    const query = vi.fn(async () => ({ rows: [{ id: ANN, displayName: 'Ann', userPrincipalName: 'ann@example.test' }] }));
    expect(await searchPeople('  100%_a  ', { pool: { query } })).toEqual([{ id: ANN, displayName: 'Ann', userPrincipalName: 'ann@example.test' }]);
    expect(query).toHaveBeenCalledWith(PEOPLE_SQL, ['%100\\%\\_a%']);
  });

  it('finds nobody for a term too short to mean anyone, without asking', async () => {
    const query = vi.fn();
    expect(await searchPeople('a', { pool: { query } })).toEqual([]);
    expect(await searchPeople(' a ', { pool: { query } })).toEqual([]);
    expect(await searchPeople(undefined, { pool: { query } })).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    query.mockResolvedValue({ rows: [] });
    await searchPeople('an', { pool: { query } });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
