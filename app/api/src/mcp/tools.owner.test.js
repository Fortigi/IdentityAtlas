// The MCP tools on behalf of a context owner. The engines are mocked: what is
// asserted is that each tool hands the owner's scope to the code that enforces
// it, that the report tools ask the REST allow-list, and that every answer says
// what it covers. The enforcement itself is proven against PostgreSQL in
// contract-tests/authzSecurity.integration.test.js.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/connection.js');
vi.mock('../nlreports/service.js', () => ({ runSpec: vi.fn(), loadValues: vi.fn(async () => ({})) }));
vi.mock('../nlreports/extFields.js', () => ({ loadExtFields: vi.fn(async () => ({})) }));
vi.mock('../nlreports/references.js', () => ({ searchNames: vi.fn(async () => []), namesOutsideScope: vi.fn(async () => []) }));
vi.mock('../reports/run.js', () => ({ runReport: vi.fn() }));
const owners = vi.hoisted(() => ({ resolved: null }));
vi.mock('../auth/contextOwner.js', () => ({
  resolveReportContexts: vi.fn(async (_pool, wanted) => owners.resolved ?? wanted),
  descendantsInScope: vi.fn(async () => true),
  resolveContextOwner: vi.fn(),
}));

const { runSpec } = await import('../nlreports/service.js');
const { searchNames, namesOutsideScope } = await import('../nlreports/references.js');
const { runReport } = await import('../reports/run.js');
const { runQuery, describeDataModel, OWNER_PREFACE } = await import('./tools/query.js');
const { search, whoAmI } = await import('./tools/identity.js');
const { listReports, runReportTool, OWNER_REPORT_NAMES } = await import('./tools/reports.js');
const { OWNER_SCOPE_DESCRIPTION } = await import('./ownerScope.js');

const BASE = 'https://atlas.example.com';
const MINE = 'a0000000-0000-4000-8000-000000000001';
const OTHER = 'b0000000-0000-4000-8000-000000000009';
const ROW_SCOPE = Object.freeze({ basis: 'context-owner', contextIds: [MINE] });
const owner = {
  contexts: [{ id: MINE, displayName: 'Support', role: 'Accountable' }],
  contextIds: new Set([MINE]),
  rowScope: ROW_SCOPE,
};
const ownerCtx = () => ({ baseUrl: BASE, user: { roles: [], permissions: new Set(), contextOwner: owner }, caller: async () => ({ principalId: 'p-carla' }) });
const analystCtx = () => ({ baseUrl: BASE, user: { roles: ['Admin'], permissions: new Set(['*']) }, caller: async () => null });

beforeEach(() => {
  vi.mocked(runSpec).mockReset();
  vi.mocked(searchNames).mockReset().mockResolvedValue([]);
  vi.mocked(namesOutsideScope).mockReset().mockResolvedValue([]);
  vi.mocked(runReport).mockReset().mockResolvedValue({ displayName: 'R', description: '', notices: [], columns: [], total: 0, truncated: false, rows: [] });
  owners.resolved = null;
});

describe('run_query', () => {
  it('runs the definition under the owner\'s row scope — both the page and the count run', async () => {
    vi.mocked(runSpec).mockResolvedValue({ ok: true, explanation: 'x', columns: [], rows: [{ a: 1 }, { a: 2 }] });
    const r = await runQuery.run({ definition: { entity: 'user' }, maxRows: 1 }, ownerCtx());
    expect(vi.mocked(runSpec).mock.calls).toHaveLength(2);
    for (const call of vi.mocked(runSpec).mock.calls) expect(call[2]).toEqual({ scope: ROW_SCOPE });
    expect(r.structuredContent.scope).toMatchObject({ restricted: true, basis: 'context-owner', contexts: [{ id: MINE, name: 'Support', role: 'Accountable' }] });
    // The total is the scoped count; truncated stays the row cap's own flag.
    expect(r.structuredContent).toMatchObject({ truncated: true, total: 2 });
  });

  it('runs unscoped for an analyst, and says so', async () => {
    vi.mocked(runSpec).mockResolvedValue({ ok: true, explanation: 'x', columns: [], rows: [] });
    const r = await runQuery.run({ definition: { entity: 'user' } }, analystCtx());
    expect(vi.mocked(runSpec).mock.calls[0][2]).toEqual({ scope: null });
    expect(r.structuredContent.scope).toMatchObject({ restricted: false, basis: 'role' });
  });
});

describe('search', () => {
  it('looks names up under the owner\'s row scope and says the matches are restricted', async () => {
    const r = await search.run({ text: 'Olga', kinds: ['account'] }, ownerCtx());
    expect(vi.mocked(searchNames).mock.calls[0][3]).toBe(ROW_SCOPE);
    expect(r.structuredContent.scope.restricted).toBe(true);
  });

  it('passes no scope for an analyst, and never asks about names outside one', async () => {
    await search.run({ text: 'Olga', kinds: ['account'] }, analystCtx());
    expect(vi.mocked(searchNames).mock.calls[0][3]).toBeNull();
    expect(namesOutsideScope).not.toHaveBeenCalled();
  });

  it('lists an exact name outside the scope as existing — accessible false, no id, no link — after the openable ones', async () => {
    vi.mocked(searchNames).mockResolvedValue([{ id: 'p-ann', name: 'Abigail Clarke', type: 'User', score: 0.4 }]);
    vi.mocked(namesOutsideScope).mockImplementation(async (_q, kind) => (kind === 'account' || kind === 'identity'
      ? [{ name: 'Abigail Davies', type: kind === 'account' ? 'User' : null }] : []));
    const r = await search.run({ text: 'Abigail Davies', kinds: ['account', 'identity', 'account'] }, ownerCtx());
    const [mine, ...outside] = r.structuredContent.matches;
    expect(mine).toMatchObject({ id: 'p-ann', accessible: true });
    expect(outside).toEqual([
      { name: 'Abigail Davies', type: 'User', entity: 'account', accessible: false, note: 'Exists, but outside the part you may see: no details can be shown.' },
      { name: 'Abigail Davies', type: null, entity: 'identity', accessible: false, note: 'Exists, but outside the part you may see: no details can be shown.' },
    ]);
    expect(vi.mocked(namesOutsideScope).mock.calls.every(c => c[3] === ROW_SCOPE)).toBe(true);
  });
});

describe('run_query naming a record outside the scope', () => {
  it('answers that it exists, with its name and type only, instead of "did you mean"', async () => {
    vi.mocked(runSpec).mockResolvedValue({
      ok: false, errors: ['…'],
      confirm: { kind: 'outOfScope', message: 'User "Abigail Davies" exists in Identity Atlas, but lies outside the part you may see, so no details about it can be shown.', outsideScope: [{ name: 'Abigail Davies', type: 'User' }], choices: [] },
    });
    const r = await runQuery.run({ definition: { entity: 'user' } }, ownerCtx());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text)).toEqual({
      error: 'User "Abigail Davies" exists in Identity Atlas, but lies outside the part you may see, so no details about it can be shown.',
      outsideScope: [{ name: 'Abigail Davies', type: 'User' }],
    });
  });

  it('still offers in-scope near matches alongside', async () => {
    vi.mocked(runSpec).mockResolvedValue({ ok: false, errors: [], confirm: { kind: 'outOfScope', message: 'm', outsideScope: [{ name: 'X', type: 'User' }], choices: [{ id: 'p1', name: 'Y' }] } });
    expect(JSON.parse((await runQuery.run({ definition: { entity: 'user' } }, ownerCtx())).content[0].text).choices).toEqual([{ id: 'p1', name: 'Y' }]);
  });
});

describe('describe_data_model and whoami', () => {
  it('opens the reference with the owner\'s scope, and only for an owner', async () => {
    const mine = (await describeDataModel.run({}, ownerCtx())).content[0].text;
    expect(mine.indexOf(OWNER_PREFACE)).toBe(0);
    expect(OWNER_PREFACE).toContain(OWNER_SCOPE_DESCRIPTION);
    expect((await describeDataModel.run({}, analystCtx())).content[0].text).not.toContain('Your scope:');
  });

  it('tells the owner which contexts they answer for', async () => {
    const r = await whoAmI.run({}, ownerCtx());
    expect(r.structuredContent.scope.contexts).toEqual([{ id: MINE, name: 'Support', role: 'Accountable' }]);
  });
});

describe('list_reports', () => {
  it('shows an owner only the reports their download allow-list holds, with how to run them', async () => {
    const r = await listReports.run({}, ownerCtx());
    expect(r.structuredContent.reports.map(x => x.name).sort()).toEqual([...OWNER_REPORT_NAMES].sort());
    expect([...OWNER_REPORT_NAMES].sort()).toEqual(['application-access-review', 'unit-members']);
    expect(r.structuredContent.note).toMatch(/your own contexts only/);
  });

  it('shows an analyst every report, without the note', async () => {
    const r = await listReports.run({}, analystCtx());
    expect(r.structuredContent.reports.length).toBeGreaterThan(OWNER_REPORT_NAMES.length);
    expect(r.structuredContent).not.toHaveProperty('note');
  });
});

describe('run_report for an owner', () => {
  it('answers a report outside their list exactly like one that does not exist', async () => {
    const outside = await runReportTool.run({ name: 'orphaned-accounts' }, ownerCtx());
    const missing = await runReportTool.run({ name: 'no-such-report' }, ownerCtx());
    expect(outside.content[0].text).toBe(missing.content[0].text);
    expect(runReport).not.toHaveBeenCalled();
  });

  it('runs the unit report on one of their own contexts, by id', async () => {
    const r = await runReportTool.run({ name: 'unit-members', parameters: { contexts: [MINE] } }, ownerCtx());
    expect(r.isError).toBeUndefined();
    expect(runReport).toHaveBeenCalledTimes(1);
    expect(r.structuredContent.scope.restricted).toBe(true);
  });

  it.each([
    ['another owner\'s context', { contexts: [OTHER] }],
    ['no context at all', {}],
    ['a context named instead of given by id', { contexts: ['Support'] }],
  ])('refuses %s without running anything', async (_label, parameters) => {
    const r = await runReportTool.run({ name: 'unit-members', parameters }, ownerCtx());
    expect(r.isError).toBe(true);
    expect(runReport).not.toHaveBeenCalled();
  });

  it('refuses an id whose report would resolve to a context outside the scope', async () => {
    owners.resolved = [OTHER];
    const r = await runReportTool.run({ name: 'unit-members', parameters: { contexts: [MINE] } }, ownerCtx());
    expect(r.isError).toBe(true);
    expect(runReport).not.toHaveBeenCalled();
  });

  it('refuses the Entitlement Pivot\'s older "applications" alias, as the REST download does', async () => {
    const r = await runReportTool.run({ name: 'application-access-review', parameters: { contexts: [MINE], applications: 'x' } }, ownerCtx());
    expect(r.isError).toBe(true);
  });

  it('leaves an analyst\'s report runs as they were', async () => {
    const r = await runReportTool.run({ name: 'orphaned-accounts' }, analystCtx());
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent.scope.restricted).toBe(false);
  });
});
