// Renamed migrations: a database that applied a migration under its old name
// records the new name instead of running the file again (migrations/renames.json).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, mkdtempSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const state = vi.hoisted(() => ({ applied: [], txQueries: [], txCount: 0 }));

vi.mock('./connection.js', () => ({
  query: vi.fn(async (sql) => (/SELECT filename FROM _migrations/.test(sql)
    ? { rows: state.applied.map(filename => ({ filename })) }
    : { rows: [] })),
  tx: vi.fn(async (fn) => {
    state.txCount += 1;
    return fn({ query: async (sql, params) => { state.txQueries.push({ sql, params }); return { rows: [] }; } });
  }),
}));

const { loadRenames, renamedToRecord, canonicalApplied, runMigrations, getMigrationStatus } = await import('./migrate.js');

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const shipped = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
const renames = loadRenames();
// A name renamed twice (092 → 094 → 095) is a key AND a value: only the last
// name in a chain ships. finalNames are those; olderNames(n) its earlier names,
// newest first.
const finalNames = Object.keys(renames).filter(n => shipped.includes(n));
const olderNames = (name) => {
  const out = [];
  for (let n = renames[name]; n && !out.includes(n); n = renames[n]) out.push(n);
  return out;
};
// A database that ran every renamed migration under one of its earlier names:
// step 0 = the name just before the latest renumber, a high step = the oldest.
const dbAtStep = (step) => shipped.filter(f => !finalNames.includes(f))
  .concat(finalNames.map(n => { const c = olderNames(n); return c[Math.min(step, c.length - 1)]; }));
const firstNew = finalNames[0];

// An insert of a renamed name into _migrations, as opposed to a migration body run.
const recordedNames = () => state.txQueries
  .filter(q => /^INSERT INTO _migrations/.test(q.sql.trim()) && /ON CONFLICT DO NOTHING/.test(q.sql))
  .map(q => q.params[0]);
const ranFiles = () => state.txQueries
  .filter(q => /^INSERT INTO _migrations \(filename\) VALUES \(\$1\)$/.test(q.sql.trim()))
  .map(q => q.params[0]);

beforeEach(() => {
  state.applied = [];
  state.txQueries = [];
  state.txCount = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

describe('migrations/renames.json', () => {
  it('maps new names to old names that are no longer shipped; every chain ends in a shipped file', () => {
    expect(finalNames.length).toBeGreaterThan(0);
    const olds = new Set(Object.values(renames));
    for (const [newName, oldName] of Object.entries(renames)) {
      expect(shipped).not.toContain(oldName);
      // Not shipped any more only because it was renamed again.
      if (!shipped.includes(newName)) expect(olds.has(newName)).toBe(true);
    }
  });

  it('loadRenames answers {} for a folder without the file', () => {
    expect(loadRenames(mkdtempSync(join(tmpdir(), 'mig-')))).toEqual({});
  });

  it('loadRenames reads the renames object of a given folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    writeFileSync(join(dir, 'renames.json'), JSON.stringify({ renames: { '010_b.sql': '009_b.sql' } }));
    expect(loadRenames(dir)).toEqual({ '010_b.sql': '009_b.sql' });
    writeFileSync(join(dir, 'renames.json'), JSON.stringify({ _comment: 'none yet' }));
    expect(loadRenames(dir)).toEqual({});
  });
});

describe('renamedToRecord', () => {
  const map = { '004_a.sql': '002_a.sql', '005_b.sql': '003_b.sql' };

  it('records a new name whose old name is applied', () => {
    expect(renamedToRecord(new Set(['001_x.sql', '002_a.sql']), map)).toEqual(['004_a.sql']);
  });

  it('records nothing when neither name is applied (the file must run)', () => {
    expect(renamedToRecord(new Set(['001_x.sql']), map)).toEqual([]);
  });

  it('records nothing when the new name is already there (idempotent)', () => {
    expect(renamedToRecord(new Set(['002_a.sql', '004_a.sql', '003_b.sql', '005_b.sql']), map)).toEqual([]);
  });

  it('follows a chain of renames from the oldest applied name', () => {
    expect(renamedToRecord(new Set(['001_a.sql']), { '003_a.sql': '002_a.sql', '002_a.sql': '001_a.sql' }))
      .toEqual(['002_a.sql', '003_a.sql']);
  });
});

describe('canonicalApplied', () => {
  it('reads an old name as its new name and drops the duplicate', () => {
    expect(canonicalApplied(['001_x.sql', '002_a.sql', '004_a.sql'], { '004_a.sql': '002_a.sql' }))
      .toEqual(['001_x.sql', '004_a.sql']);
  });

  it('follows a chain and stops on a cycle', () => {
    expect(canonicalApplied(['001_a.sql'], { '002_a.sql': '001_a.sql', '003_a.sql': '002_a.sql' })).toEqual(['003_a.sql']);
    expect(canonicalApplied(['001_a.sql'], { '002_a.sql': '001_a.sql', '001_a.sql': '002_a.sql' })).toHaveLength(1);
  });

  it('leaves unrelated names alone', () => {
    expect(canonicalApplied(['001_x.sql'], { '004_a.sql': '002_a.sql' })).toEqual(['001_x.sql']);
  });
});

describe('runMigrations with renamed migrations', () => {
  it('a database that ran the previous names records the new names and runs no file', async () => {
    state.applied = dbAtStep(0);
    await runMigrations();
    expect(recordedNames().sort()).toEqual([...finalNames].sort());
    expect(ranFiles()).toEqual([]);
    expect(state.txCount).toBe(1); // all renames in one transaction
  });

  it('a database that ran the oldest names follows each chain to the shipped name and runs no file', async () => {
    state.applied = dbAtStep(99);
    await runMigrations();
    expect(recordedNames()).toEqual(expect.arrayContaining(finalNames));
    expect(ranFiles()).toEqual([]);
  });

  // The stack's 094–097 were renumbered to 095–098 when main took 094 for the
  // MCP audit log. A database that ran them under 094–097 (and never saw main's
  // 094) must run main's 094 and nothing else.
  it('a database from before the 094 renumber runs only the main 094_mcp_tool_calls', async () => {
    const before = [
      ['095_context_templates.sql', '094_context_templates.sql'],
      ['096_context_role_suggestion_rejections.sql', '095_context_role_suggestion_rejections.sql'],
      ['097_synced_context_accountables.sql', '096_synced_context_accountables.sql'],
      ['098_context_uploads.sql', '097_context_uploads.sql'],
    ].filter(([n]) => shipped.includes(n));
    expect(before.length).toBeGreaterThanOrEqual(3);
    for (const [n, o] of before) expect(renames[n]).toBe(o);
    const renumbered = new Set(before.map(([n]) => n));
    state.applied = shipped.filter(f => !renumbered.has(f) && f !== '094_mcp_tool_calls.sql')
      .concat(before.map(([, o]) => o));
    await runMigrations();
    expect(ranFiles()).toEqual(['094_mcp_tool_calls.sql']);
    expect(recordedNames().sort()).toEqual([...renumbered].sort());
  });

  it('is idempotent: a second boot (old and new names recorded) records and runs nothing', async () => {
    state.applied = dbAtStep(0).concat(Object.keys(renames));
    await runMigrations();
    expect(state.txQueries).toEqual([]);
  });

  it('a renamed migration recorded under none of its names runs', async () => {
    const names = new Set(olderNames(firstNew));
    state.applied = dbAtStep(0).filter(f => !names.has(f));
    await runMigrations();
    expect(ranFiles()).toEqual([firstNew]);
    expect(recordedNames()).not.toContain(firstNew);
  });

  it('a fresh database runs every file, renamed ones included, and records no rename', async () => {
    state.applied = [];
    await runMigrations();
    expect(ranFiles()).toEqual(shipped);
    expect(recordedNames()).toEqual([]);
  });
});

describe('getMigrationStatus with renamed migrations', () => {
  it('an old-name row is not "ahead" of the code once the new name is recorded', async () => {
    const rows = shipped.concat(Object.values(renames)).map(filename => ({ filename }));
    const s = await getMigrationStatus({ query: async () => ({ rows }) });
    expect(s).toMatchObject({ ahead: false, pending: false, applied: shipped.length });
  });

  it('an old-name row alone already counts as the renamed migration (not pending)', async () => {
    for (const step of [0, 99]) {
      const rows = dbAtStep(step).map(filename => ({ filename }));
      const s = await getMigrationStatus({ query: async () => ({ rows }) });
      expect(s).toMatchObject({ ahead: false, pending: false });
    }
  });
});
