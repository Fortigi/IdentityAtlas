import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logConversation, findAnswerForCaller, sweepExpired, retentionDays, DEFAULT_RETENTION_DAYS, newConversationId } from './log.js';

const ID = '11111111-1111-1111-1111-111111111111';
const OID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const entry = (over = {}) => ({
  id: ID, callerOid: OID, callerPrincipalId: OID, conversationId: 'conv-1',
  question: 'which groups is Jan in?', language: 'en',
  definition: { entity: 'user', conditions: [] }, outcome: 'answered',
  rowCount: 3, columns: ['displayName'], truncated: false,
  modelMs: 49_000, queryMs: 120, totalMs: 49_500, ...over,
});

/** The INSERT's parameter array, keyed by the column order in the SQL. */
function params(q) {
  const [sql, values] = q.mock.calls[0];
  const names = sql.match(/\(([^)]*)\)\s*VALUES/s)[1].match(/"(\w+)"/g).map(s => s.replace(/"/g, ''));
  return Object.fromEntries(names.map((n, i) => [n, values[i]]));
}

describe('logConversation', () => {
  it('writes the measurements the POC exists to produce', async () => {
    const q = vi.fn(async () => ({}));
    await logConversation(entry(), q);

    const p = params(q);
    expect(p.modelMs).toBe(49_000);
    expect(p.queryMs).toBe(120);
    expect(p.totalMs).toBe(49_500);
    expect(p.outcome).toBe('answered');
    expect(p.rowCount).toBe(3);
    expect(p.columns).toEqual(['displayName']);
  });

  it('stores the definition as JSON, and the column NAMES only — never the rows', async () => {
    const q = vi.fn(async () => ({}));
    await logConversation(entry(), q);

    const p = params(q);
    expect(JSON.parse(p.definition)).toEqual({ entity: 'user', conditions: [] });
    // There is no parameter carrying row data at all: every value is a scalar,
    // the column-name array, or the definition.
    const [, values] = q.mock.calls[0];
    expect(values.filter(v => Array.isArray(v))).toEqual([['displayName']]);
  });

  it('strips line breaks from the question so it cannot forge a second log line', async () => {
    const q = vi.fn(async () => ({}));
    await logConversation(entry({ question: 'real question\nnl-reports interpret: user=admin outcome=answered' }), q);

    const p = params(q);
    expect(p.question).not.toContain('\n');
    expect(p.question).toContain('real question');
  });

  it('caps a very long question instead of writing it whole', async () => {
    const q = vi.fn(async () => ({}));
    await logConversation(entry({ question: 'x'.repeat(5000) }), q);
    expect(params(q).question).toHaveLength(2000);
  });

  it('returns the row id it wrote', async () => {
    await expect(logConversation(entry(), vi.fn(async () => ({})))).resolves.toBe(ID);
  });

  it('swallows a write failure and returns null — a lost measurement must not cost the answer', async () => {
    // The manager has been waiting two minutes; failing here would throw that
    // away to record that it happened.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const q = vi.fn(async () => { throw new Error('deadlock detected'); });

    await expect(logConversation(entry(), q)).resolves.toBeNull();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('writes nulls, not undefined, for everything a failed question has no value for', async () => {
    // node-postgres sends undefined as null anyway, but an explicit null is
    // what makes "was this measured?" answerable rather than ambiguous.
    const q = vi.fn(async () => ({}));
    await logConversation({ id: ID, question: 'x', outcome: 'unknown-caller' }, q);

    const [, values] = q.mock.calls[0];
    expect(values.every(v => v !== undefined)).toBe(true);
    expect(params(q).definition).toBeNull();
    expect(params(q).modelMs).toBeNull();
  });
});

describe('findAnswerForCaller', () => {
  it('requires BOTH the id and the caller who asked', async () => {
    // The link travels in a chat message and chat messages get forwarded.
    const q = vi.fn(async () => ({ id: ID, question: 'q', definition: {} }));
    await findAnswerForCaller(ID, OID, q);

    const [sql, values] = q.mock.calls[0];
    expect(values).toEqual([ID, OID]);
    expect(sql).toMatch(/"id"\s*=\s*\$1\s+AND\s+"callerOid"\s*=\s*\$2/);
  });

  it('will not serve a row that has no definition to re-run', async () => {
    const q = vi.fn(async () => null);
    await findAnswerForCaller(ID, OID, q);
    expect(q.mock.calls[0][0]).toMatch(/"definition"\s+IS\s+NOT\s+NULL/);
  });

  it('returns null rather than undefined when there is no match', async () => {
    await expect(findAnswerForCaller(ID, OID, vi.fn(async () => undefined))).resolves.toBeNull();
  });
});

describe('retention', () => {
  const original = process.env.TEAMS_BOT_LOG_RETENTION_DAYS;
  afterEach(() => {
    if (original === undefined) delete process.env.TEAMS_BOT_LOG_RETENTION_DAYS;
    else process.env.TEAMS_BOT_LOG_RETENTION_DAYS = original;
  });

  it('defaults to 90 days', () => {
    expect(retentionDays({})).toBe(DEFAULT_RETENTION_DAYS);
    expect(DEFAULT_RETENTION_DAYS).toBe(90);
  });

  it('takes a positive whole number of days from the environment', () => {
    expect(retentionDays({ TEAMS_BOT_LOG_RETENTION_DAYS: '30' })).toBe(30);
    expect(retentionDays({ TEAMS_BOT_LOG_RETENTION_DAYS: '1' })).toBe(1);
  });

  it.each([
    ['0', 'zero would delete every row on the next sweep'],
    ['-1', 'negative'],
    ['1.5', 'fractional'],
    ['forever', 'not a number'],
    ['', 'empty'],
  ])('falls back to the default for %j (%s)', (value) => {
    expect(retentionDays({ TEAMS_BOT_LOG_RETENTION_DAYS: value })).toBe(DEFAULT_RETENTION_DAYS);
  });

  it('sweeps by age, parameterised, and reports how many rows went', async () => {
    const q = vi.fn(async () => ({ rowCount: 7 }));
    await expect(sweepExpired(30, q)).resolves.toBe(7);

    const [sql, values] = q.mock.calls[0];
    expect(values).toEqual(['30']);
    expect(sql).toMatch(/DELETE FROM "BotConversations"/);
    expect(sql).not.toContain('30');
  });

  it('reports 0 rather than undefined when the driver gives no count', async () => {
    await expect(sweepExpired(30, vi.fn(async () => ({})))).resolves.toBe(0);
  });
});

describe('newConversationId', () => {
  it('is a fresh uuid each time', () => {
    const a = newConversationId();
    const b = newConversationId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
});
