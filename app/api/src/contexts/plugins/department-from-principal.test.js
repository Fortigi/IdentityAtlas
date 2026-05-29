// Unit tests for the department-from-principal context plugin.
// Uses vi.doMock to inject a stub db so no real database is needed.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const PRINCIPALS = [
  { id: 'p1', department: 'Finance' },
  { id: 'p2', department: 'Finance' },
  { id: 'p3', department: 'IT' },
  { id: 'p4', department: '  IT  ' },   // whitespace — should normalise to 'IT'
  { id: 'p5', department: null },        // null — must be excluded
  { id: 'p6', department: '' },          // empty string — must be excluded
];

async function loadPlugin(rows) {
  vi.resetModules();
  vi.doMock('../../db/connection.js', () => ({
    query: vi.fn(async () => ({ rows })),
  }));
  const mod = await import('./department-from-principal.js');
  return mod.default;
}

describe('department-from-principal plugin', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns empty when no principals have a department', async () => {
    const plugin = await loadPlugin([]);
    const out = await plugin.run({}, {});
    expect(out.contexts).toHaveLength(0);
    expect(out.members).toHaveLength(0);
  });

  it('creates one context per unique department value', async () => {
    const plugin = await loadPlugin(PRINCIPALS);
    const out = await plugin.run({}, {});
    const depts = out.contexts.map(c => c.displayName).sort();
    expect(depts).toEqual(['Finance', 'IT']);
  });

  it('sets contextType to Department on every context', async () => {
    const plugin = await loadPlugin(PRINCIPALS);
    const out = await plugin.run({}, {});
    expect(out.contexts.every(c => c.contextType === 'Department')).toBe(true);
  });

  it('uses a stable externalId derived from the department name', async () => {
    const plugin = await loadPlugin(PRINCIPALS);
    const out = await plugin.run({}, {});
    const finance = out.contexts.find(c => c.displayName === 'Finance');
    expect(finance.externalId).toBe('dept:Finance');
  });

  it('assigns each principal to their department context', async () => {
    const plugin = await loadPlugin(PRINCIPALS);
    const out = await plugin.run({}, {});
    const financeMembers = out.members
      .filter(m => m.contextExternalId === 'dept:Finance')
      .map(m => m.memberId)
      .sort();
    expect(financeMembers).toEqual(['p1', 'p2']);
  });

  it('trims whitespace from department values', async () => {
    const plugin = await loadPlugin(PRINCIPALS);
    const out = await plugin.run({}, {});
    // p3 and p4 both have department 'IT' (p4 after trim) — one context, two members.
    const itMembers = out.members
      .filter(m => m.contextExternalId === 'dept:IT')
      .map(m => m.memberId)
      .sort();
    expect(itMembers).toEqual(['p3', 'p4']);
  });

  it('excludes principals with null or empty department', async () => {
    const plugin = await loadPlugin(PRINCIPALS);
    const out = await plugin.run({}, {});
    const memberIds = out.members.map(m => m.memberId);
    expect(memberIds).not.toContain('p5');
    expect(memberIds).not.toContain('p6');
  });

  it('passes scopeSystemId to the db query when provided', async () => {
    vi.resetModules();
    const mockQuery = vi.fn(async () => ({ rows: [] }));
    vi.doMock('../../db/connection.js', () => ({ query: mockQuery }));
    const mod = await import('./department-from-principal.js');
    await mod.default.run({ scopeSystemId: 42 }, {});
    const [sql, args] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/systemId/);
    expect(args).toContain(42);
  });
});
