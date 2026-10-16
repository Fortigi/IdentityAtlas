import { describe, it, expect, beforeEach, vi } from 'vitest';
import { writeActivities, upsertKeys, KEY_CHUNK } from './activityWrite.js';
import { CHUNK } from './writeRun.js';

// A transaction client that hands out ids for keys and records every statement.
function fakeClient({ deleted = 0 } = {}) {
  const ids = new Map();
  const client = {
    calls: [],
    query: vi.fn(async (sql, params) => {
      client.calls.push([sql, params]);
      if (sql.includes('SELECT "id", "rawValue" FROM "OrgActivityKeys"')) {
        const [, role, values] = params;
        return { rows: values.map(v => ({ id: ids.get(`${role}:${v}`) ?? ids.set(`${role}:${v}`, `${role}-${v}`).get(`${role}:${v}`), rawValue: v })) };
      }
      if (sql.startsWith('DELETE FROM "OrgActivities"')) return { rowCount: deleted };
      return { rows: [], rowCount: 0 };
    }),
  };
  return client;
}

const fact = (row, actor, subject, extra = {}) => ({
  row, sourceLocator: `row:${row}`, actor, subject, occurredOn: '2026-03-01', periodEnd: '2026-03-31', measure: 7.5, unit: 'h', attributes: {}, ...extra,
});
const profile = { id: 'prof-2', name: 'Hours', recipe: { activity: { type: 'Uren' } } };
const source = { id: 'src-1' };

let client;
beforeEach(() => { client = fakeClient({ deleted: 12 }); });

describe('upsertKeys', () => {
  it('inserts each distinct value once per role, never overwriting an existing key, and maps value → id', async () => {
    const keyIds = await upsertKeys(client, 'Hours', [fact(1, 'Ann', 'Contoso'), fact(2, 'Ann', 'Northwind'), fact(3, 'Bob', 'Contoso')]);
    const upserts = client.calls.filter(([s]) => s.includes('INSERT INTO "OrgActivityKeys"'));
    expect(upserts).toHaveLength(2);
    expect(upserts[0][0]).toMatch(/ON CONFLICT \("profileName", "role", "rawValue"\) DO NOTHING/);
    const [name, newIds, roles, values] = upserts[0][1];
    expect([name, roles, values]).toEqual(['Hours', ['actor', 'actor'], ['Ann', 'Bob']]);
    expect(newIds).toHaveLength(2);
    expect(upserts[1][1][3]).toEqual(['Contoso', 'Northwind']);
    expect([...keyIds.actor]).toEqual([['Ann', 'actor-Ann'], ['Bob', 'actor-Bob']]);
    expect([...keyIds.subject]).toEqual([['Contoso', 'subject-Contoso'], ['Northwind', 'subject-Northwind']]);
  });

  it('sends the values in chunks of KEY_CHUNK', async () => {
    const facts = Array.from({ length: KEY_CHUNK + 1 }, (_, i) => fact(i + 1, `P${i}`, 'Contoso'));
    await upsertKeys(client, 'Hours', facts);
    const actorUpserts = client.calls.filter(([s, p]) => s.includes('INSERT INTO "OrgActivityKeys"') && p[2][0] === 'actor');
    expect(actorUpserts.map(([, p]) => p[3].length)).toEqual([KEY_CHUNK, 1]);
  });
});

describe('writeActivities', () => {
  it('a full run deletes the profile name\'s activities first, then inserts every fact with its key ids', async () => {
    const out = await writeActivities({ client, run: { id: 'run-1', mode: 'full' }, source, profile, facts: [fact(1, 'Ann', 'Contoso'), fact(2, 'Bob', 'Contoso', { measure: null })] });
    expect(out.inserted).toBe(2);
    expect(out.deleted).toBe(12);
    const del = client.calls.findIndex(([s]) => s.startsWith('DELETE FROM "OrgActivities"'));
    const ins = client.calls.findIndex(([s]) => s.includes('INSERT INTO "OrgActivities"'));
    expect(del).toBeGreaterThan(-1);
    expect(del).toBeLessThan(ins);
    expect(client.calls[del][1]).toEqual(['Hours']);
    const [, [json, ...params]] = client.calls[ins];
    expect(params).toEqual(['Hours', 'Uren', 'prof-2', 'run-1', 'src-1']);
    const rows = JSON.parse(json);
    expect(rows.map(r => [r.actorKeyId, r.subjectKeyId, r.measure, r.sourceLocator])).toEqual([
      ['actor-Ann', 'subject-Contoso', 7.5, 'row:1'],
      ['actor-Bob', 'subject-Contoso', null, 'row:2'],
    ]);
    expect(rows[0]).toMatchObject({ occurredOn: '2026-03-01', periodEnd: '2026-03-31', unit: 'h', attributes: {} });
  });

  it('a delta run deletes nothing and appends', async () => {
    const out = await writeActivities({ client, run: { id: 'run-1', mode: 'delta' }, source, profile, facts: [fact(1, 'Ann', 'Contoso')] });
    expect(out.deleted).toBe(0);
    expect(client.calls.some(([s]) => s.startsWith('DELETE'))).toBe(false);
  });

  it('inserts in chunks of CHUNK facts', async () => {
    const facts = Array.from({ length: CHUNK + 1 }, (_, i) => fact(i + 1, 'Ann', 'Contoso'));
    await writeActivities({ client, run: { id: 'run-1', mode: 'delta' }, source, profile, facts });
    const inserts = client.calls.filter(([s]) => s.includes('INSERT INTO "OrgActivities"'));
    expect(inserts.map(([, p]) => JSON.parse(p[0]).length)).toEqual([CHUNK, 1]);
  });

  it('a file without facts writes no activity and no key', async () => {
    const out = await writeActivities({ client, run: { id: 'run-1', mode: 'delta' }, source, profile, facts: [] });
    expect(out).toMatchObject({ inserted: 0, deleted: 0 });
    expect(client.query).not.toHaveBeenCalled();
  });
});
