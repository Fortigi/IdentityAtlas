// The MCP tools on behalf of a context owner. The engines are mocked: what is
// asserted is that each tool hands the owner's scope to the code that enforces
// it, that the report tools ask the REST allow-list, and that every answer says
// what it covers. The enforcement itself is proven against PostgreSQL in
// contract-tests/authzSecurity.integration.test.js.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/connection.js');
vi.mock('../nlreports/service.js', () => ({ runSpec: vi.fn(), loadValues: vi.fn(async () => ({})) }));
vi.mock('../nlreports/extFields.js', () => ({ loadExtFields: vi.fn(async () => ({})) }));
vi.mock('../nlreports/references.js', () => ({ searchNames: vi.fn(async () => []) }));
vi.mock('../reports/run.js', () => ({ runReport: vi.fn() }));
const owners = vi.hoisted(() => ({ resolved: null }));
vi.mock('../auth/contextOwner.js', () => ({
  resolveReportContexts: vi.fn(async (_pool, wanted) => owners.resolved ?? wanted),
  descendantsInScope: vi.fn(async () => true),
  resolveContextOwner: vi.fn(),
}));

const { runSpec } = await import('../nlreports/service.js');
const { searchNames } = await import('../nlreports/references.js');
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

  it('passes no scope for an analyst', async () => {
    await search.run({ text: 'Olga', kinds: ['account'] }, analystCtx());
    expect(vi.mocked(searchNames).mock.calls[0][3]).toBeNull();
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
