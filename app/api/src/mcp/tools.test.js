// Unit tests for the MCP tools, result shaping, audit log and tool dispatch.
// The engines they sit on (runSpec, searchNames, the model reference) are mocked
// here: what is asserted is what the MCP layer adds — the caller substitution,
// the row cap, links, parameter conversion, refusals and the audit trail.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/connection.js');
vi.mock('../nlreports/service.js', () => ({
  runSpec: vi.fn(),
  loadValues: vi.fn(async () => ({ principalType: ['User', 'ServicePrincipal'] })),
}));
vi.mock('../nlreports/extFields.js', () => ({
  loadExtFields: vi.fn(async () => ({ user: { 'ext.costCenter': { label: 'Cost center', type: 'text' } }, group: {} })),
}));
vi.mock('../nlreports/references.js', () => ({ searchNames: vi.fn() }));

import { query } from '../db/connection.js';
import { runSpec } from '../nlreports/service.js';
import { searchNames } from '../nlreports/references.js';
import { describeDataModel, runQuery, lazyCaller, attributesBlock } from './tools/query.js';
import { search, whoAmI } from './tools/identity.js';
import { asQueryParams, runReportTool, listReports } from './tools/reports.js';
import { rowLimit, cleanRow, tableResult, errorResult, DEFAULT_ROWS, MAX_ROWS } from './result.js';
import { recordToolCall, listToolCalls, storedArguments, clip } from './audit.js';
import { callTool, allowedTools, TOOLS } from './server.js';
import { challengeHeader } from './resource.js';

const BASE = 'https://atlas.example.com';
const ctxWith = (caller = null, user = {}) => ({ baseUrl: BASE, user, caller: async () => caller });

beforeEach(() => {
  vi.mocked(runSpec).mockReset();
  vi.mocked(searchNames).mockReset();
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
});

describe('rowLimit', () => {
  it('defaults, caps and rejects nonsense', () => {
    expect(rowLimit(undefined)).toBe(DEFAULT_ROWS);
    expect(rowLimit(0)).toBe(DEFAULT_ROWS);
    expect(rowLimit(-5)).toBe(DEFAULT_ROWS);
    expect(rowLimit(2.5)).toBe(DEFAULT_ROWS);
    expect(rowLimit('abc')).toBe(DEFAULT_ROWS);
    expect(rowLimit(1)).toBe(1);
    expect(rowLimit(MAX_ROWS)).toBe(MAX_ROWS);
    expect(rowLimit(MAX_ROWS + 1)).toBe(MAX_ROWS);
  });
});

describe('cleanRow / tableResult', () => {
  it('drops UI-only keys, keeps the rest, and links rows that have a record', () => {
    expect(cleanRow({ a: 1, _entity: { kind: 'resource', id: 'g/1' }, _links: { a: [] } }, BASE))
      .toEqual({ a: 1, link: `${BASE}/#resource:g%2F1` });
    expect(cleanRow({ a: 1, count: 3 }, BASE)).toEqual({ a: 1, count: 3 });
  });

  it('is not truncated when the rows fit exactly, and is when one more exists', () => {
    const rows = [{ a: 1 }, { a: 2 }];
    expect(tableResult({ rows, limit: 2, baseUrl: BASE }).structuredContent).toMatchObject({ rowCount: 2, truncated: false });
    expect(tableResult({ rows, limit: 1, baseUrl: BASE }).structuredContent).toMatchObject({ rowCount: 1, truncated: true });
    // A source that already knows it was cut off keeps saying so.
    expect(tableResult({ rows, limit: 5, baseUrl: BASE, truncated: true }).structuredContent.truncated).toBe(true);
    expect(tableResult({ rows, limit: 1, baseUrl: BASE }).rowCount).toBe(1);
  });

  it('errorResult flags the error and carries details', () => {
    const r = errorResult('nope', { errors: ['x'] });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text)).toEqual({ error: 'nope', errors: ['x'] });
    expect(JSON.parse(errorResult('plain').content[0].text)).toEqual({ error: 'plain' });
  });
});

describe('run_query', () => {
  it('runs the definition for the signed-in caller, one row over the cap, and reports the cut-off', async () => {
    vi.mocked(runSpec).mockResolvedValue({
      ok: true, explanation: 'Groups Ada is a member of', columns: [{ key: 'displayName', label: 'Name' }],
      rows: [{ displayName: 'G1', _entity: { kind: 'resource', id: 'g1' } }, { displayName: 'G2' }, { displayName: 'G3' }],
    });
    const definition = { entity: 'group', conditions: [{ relation: 'members', quantifier: 'some', conditions: [{ field: 'id', op: 'eq', value: '@me' }] }] };
    const r = await runQuery.run({ definition, maxRows: 2 }, ctxWith({ principalId: 'p-ada' }));

    const [spec, subs] = vi.mocked(runSpec).mock.calls[0];
    expect(spec).toEqual({ ...definition, limit: 3 });
    expect(subs.get('@me')).toBe('p-ada');
    expect(r.structuredContent).toMatchObject({ explanation: 'Groups Ada is a member of', rowCount: 2, truncated: true });
    expect(r.structuredContent.rows[0]).toEqual({ displayName: 'G1', link: `${BASE}/#resource:g1` });
  });

  it('has no @me without a linked account', async () => {
    vi.mocked(runSpec).mockResolvedValue({ ok: true, explanation: '', columns: [], rows: [] });
    await runQuery.run({ definition: { entity: 'user' } }, ctxWith(null));
    expect(vi.mocked(runSpec).mock.calls[0][1].size).toBe(0);
  });

  it('passes validation errors and "did you mean" choices back as an error result', async () => {
    vi.mocked(runSpec).mockResolvedValueOnce({ ok: false, errors: ['unknown field "foo"'] });
    let r = await runQuery.run({ definition: { entity: 'user' } }, ctxWith());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text)).toEqual({ error: 'The definition is not valid.', errors: ['unknown field "foo"'] });

    vi.mocked(runSpec).mockResolvedValueOnce({ ok: false, errors: ['No group named "Fin"'], confirm: { choices: [{ id: 'g1', name: 'Finance' }] } });
    r = await runQuery.run({ definition: { entity: 'group' } }, ctxWith());
    expect(JSON.parse(r.content[0].text)).toMatchObject({ error: 'Did you mean one of these?', choices: [{ id: 'g1', name: 'Finance' }] });
  });

  it('refuses a definition that is not an object without running anything', async () => {
    for (const definition of [undefined, 'SELECT 1', [1], null]) {
      expect((await runQuery.run({ definition }, ctxWith())).isError).toBe(true);
    }
    expect(runSpec).not.toHaveBeenCalled();
  });
});

describe('describe_data_model', () => {
  it('gives the MCP preface, the model reference, this deployment\'s values and its own attributes', async () => {
    const r = await describeDataModel.run({}, ctxWith());
    const text = r.content[0].text;
    expect(text.indexOf('How to use this with Identity Atlas over MCP')).toBe(0);
    expect(text).toContain('# Entities');
    expect(text).toContain('User | ServicePrincipal');
    expect(text).toContain('ext.costCenter (Cost center, text)');
  });

  it('leaves the attribute block out when there are none', () => {
    expect(attributesBlock({ user: {} })).toBe('');
    expect(attributesBlock(undefined)).toBe('');
  });
});

describe('lazyCaller', () => {
  it('resolves at most once, and never without an oid', async () => {
    const resolve = vi.fn(async () => ({ principalId: 'p1' }));
    const get = lazyCaller('oid-1', resolve);
    expect(await get()).toEqual({ principalId: 'p1' });
    await get();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(await lazyCaller(undefined, resolve)()).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('treats a lookup failure as "no account"', async () => {
    expect(await lazyCaller('oid', async () => { throw new Error('db down'); })()).toBeNull();
  });
});

describe('search', () => {
  it('looks in the default places, merges by score and links each match to its own detail page', async () => {
    vi.mocked(searchNames).mockImplementation(async (_q, entity) => ({
      identity: [{ id: 'i1', name: 'Ada Lovelace', type: null, score: 0.5 }],
      account: [{ id: 'a1', name: 'Ada L', type: 'User', score: 0.9 }],
      resource: [],
    })[entity]);
    const r = await search.run({ text: ' Ada ' }, ctxWith());
    expect(vi.mocked(searchNames).mock.calls.map(c => [c[1], c[2]])).toEqual([['identity', 'Ada'], ['account', 'Ada'], ['resource', 'Ada']]);
    expect(r.structuredContent.matches).toEqual([
      { id: 'a1', name: 'Ada L', type: 'User', score: 0.9, entity: 'account', link: `${BASE}/#user:a1` },
      { id: 'i1', name: 'Ada Lovelace', type: null, score: 0.5, entity: 'identity', link: `${BASE}/#identity:i1` },
    ]);
  });

  it('lists a record found under two kinds once — a group is also a resource', async () => {
    vi.mocked(searchNames).mockImplementation(async (_q, entity) => ({
      group: [{ id: 'g1', name: 'Admins', type: 'Group', score: 0.6 }],
      resource: [{ id: 'g1', name: 'Admins', type: 'Group', score: 0.6 }, { id: 'r2', name: 'Admin app', type: 'Application', score: 0.5 }],
    })[entity]);
    const r = await search.run({ text: 'admin', kinds: ['group', 'resource'] }, ctxWith());
    expect(r.structuredContent.matches.map(m => [m.id, m.entity])).toEqual([['g1', 'group'], ['r2', 'resource']]);
    expect(r.rowCount).toBe(2);
  });

  it('searches only the kinds asked for, once each, ignoring unknown ones', async () => {
    vi.mocked(searchNames).mockResolvedValue([]);
    await search.run({ text: 'Fin', kinds: ['group', 'group', 'change', 'nope'] }, ctxWith());
    expect(vi.mocked(searchNames).mock.calls.map(c => c[1])).toEqual(['group']);
  });

  it('refuses text that is too short or too long', async () => {
    expect((await search.run({ text: 'a' }, ctxWith())).isError).toBe(true);
    expect((await search.run({ text: 'x'.repeat(101) }, ctxWith())).isError).toBe(true);
    expect(searchNames).not.toHaveBeenCalled();
  });
});

describe('whoami', () => {
  it('names the user, their roles and their account with a link', async () => {
    const r = await whoAmI.run({}, ctxWith({ principalId: 'p1', displayName: 'Ada' }, { name: 'Ada', preferred_username: 'ada@x', roles: ['Reader'] }));
    expect(r.structuredContent).toEqual({
      name: 'Ada', username: 'ada@x', roles: ['Reader'],
      account: { principalId: 'p1', displayName: 'Ada', link: `${BASE}/#user:p1` },
    });
  });

  it('says when the sign-in is not linked to an account', async () => {
    const r = await whoAmI.run({}, ctxWith(null, { upn: 'ada@x' }));
    expect(r.structuredContent).toMatchObject({ username: 'ada@x', account: null, roles: [] });
    expect(r.structuredContent.note).toMatch(/not linked/);
  });
});

describe('report tools', () => {
  it('turns JSON parameters into what a query string would carry', () => {
    expect(asQueryParams({ a: true, b: 3, c: ['x', 1], d: null, e: undefined, f: 'y' }))
      .toEqual({ a: 'true', b: '3', c: ['x', '1'], f: 'y' });
    expect(asQueryParams(undefined)).toEqual({});
    expect(asQueryParams(['a'])).toEqual({});
    expect(asQueryParams('a=1')).toEqual({});
  });

  it('says so when the report does not exist', async () => {
    const r = await runReportTool.run({ name: 'no-such-report' }, ctxWith());
    expect(r.isError).toBe(true);
  });

  it('lists the built-in reports with their parameters', async () => {
    const r = await listReports.run({}, ctxWith());
    const names = r.structuredContent.reports.map(x => x.name);
    expect(names).toContain('orphaned-accounts');
    expect(r.rowCount).toBe(names.length);
    for (const rep of r.structuredContent.reports) expect(rep.parameters).toBeTruthy();
  });
});

describe('audit log', () => {
  it('stores small arguments whole and large ones as a marked prefix', () => {
    expect(storedArguments({ a: 1 })).toEqual({ a: 1 });
    expect(storedArguments(null)).toBeNull();
    const big = storedArguments({ s: 'x'.repeat(5000) });
    expect(big.truncated).toBe(true);
    expect(big.start).toHaveLength(4000);
    expect(clip('y'.repeat(400))).toHaveLength(300);
    expect(clip(null)).toBeNull();
  });

  it('writes one row and never throws when the write fails', async () => {
    const q = vi.fn().mockRejectedValueOnce(new Error('no table'));
    await expect(recordToolCall({ tool: 't', outcome: 'ok' }, q)).resolves.toBeUndefined();
    q.mockResolvedValueOnce({});
    await recordToolCall({ userOid: 'o', userName: 'n', client: 'c', tool: 't', arguments: { a: 1 }, outcome: 'ok', rowCount: 0, durationMs: 5 }, q);
    expect(q.mock.calls[1][1]).toEqual(['o', 'n', 'c', 't', '{"a":1}', 'ok', 0, 5, null]);
  });

  it('lists recent calls with a bounded limit', async () => {
    const q = vi.fn(async () => ({ rows: [{ id: 1 }] }));
    expect(await listToolCalls({}, q)).toEqual([{ id: 1 }]);
    await listToolCalls({ limit: '9999' }, q);
    await listToolCalls({ limit: '-3' }, q);
    await listToolCalls({ limit: 'x' }, q);
    await listToolCalls({ limit: '0' }, q);
    expect(q.mock.calls.map(c => c[1][0])).toEqual([50, 500, 1, 50, 50]);
  });
});

describe('callTool', () => {
  const user = { oid: 'o1', upn: 'ada@x', permissions: new Set(['mcp.use']) };

  it('logs a failure and answers with a generic error, not the exception', async () => {
    const audit = vi.fn();
    const boom = { name: 'boom', run: async () => { throw new Error('secret SQL detail'); } };
    const r = await callTool([boom], { name: 'boom', arguments: { x: 1 } }, { user, client: 'c' }, audit);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).not.toContain('secret');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ tool: 'boom', outcome: 'failed', error: 'secret SQL detail', userName: 'ada@x' }));
  });

  it('records an invalid call as invalid, and never passes rowCount to the client', async () => {
    const audit = vi.fn();
    const bad = { name: 'bad', run: async () => errorResult('bad input') };
    const r = await callTool([bad], { name: 'bad' }, { user }, audit);
    expect(r).not.toHaveProperty('rowCount');
    expect(audit.mock.calls[0][0]).toMatchObject({ outcome: 'invalid', arguments: null });
  });

  it('filters tools by permission, keeping permission-less ones', () => {
    expect(allowedTools({ permissions: new Set(['mcp.use']) }).map(t => t.name)).toEqual(['whoami']);
    expect(allowedTools({ permissions: new Set(['*']) })).toHaveLength(TOOLS.length);
    expect(allowedTools(undefined).map(t => t.name)).toEqual(['whoami']);
  });
});

describe('challengeHeader', () => {
  it('adds the error code when there is one', () => {
    const req = { protocol: 'http', get: () => 'h' };
    expect(challengeHeader(req, 'invalid_token', { PUBLIC_BASE_URL: 'https://a.b/' }))
      .toBe('Bearer resource_metadata="https://a.b/.well-known/oauth-protected-resource/mcp", scope="https://a.b/mcp/Mcp.Read", error="invalid_token"');
  });
});
