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
const [firstNew, firstOld] = Object.entries(renames)[0];

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
  it('maps shipped new names to old names that are no longer shipped', () => {
    expect(Object.keys(renames).length).toBeGreaterThan(0);
    for (const [newName, oldName] of Object.entries(renames)) {
      expect(shipped).toContain(newName);
      expect(shipped).not.toContain(oldName);
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
  const oldNameDb = () => shipped.filter(f => !(f in renames)).concat(Object.values(renames));

  it('a database that ran the old names records the new names and runs no file', async () => {
    state.applied = oldNameDb();
    await runMigrations();
    expect(recordedNames().sort()).toEqual(Object.keys(renames).sort());
    expect(ranFiles()).toEqual([]);
    expect(state.txCount).toBe(1); // all renames in one transaction
  });

  it('is idempotent: a second boot (old and new names recorded) records and runs nothing', async () => {
    state.applied = oldNameDb().concat(Object.keys(renames));
    await runMigrations();
    expect(state.txQueries).toEqual([]);
  });

  it('a renamed migration recorded under neither name runs', async () => {
    state.applied = oldNameDb().filter(f => f !== firstOld);
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
    const rows = shipped.filter(f => !(f in renames)).concat(Object.values(renames)).map(filename => ({ filename }));
    const s = await getMigrationStatus({ query: async () => ({ rows }) });
    expect(s).toMatchObject({ ahead: false, pending: false });
  });
});
