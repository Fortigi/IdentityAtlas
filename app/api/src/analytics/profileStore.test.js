// profileStore.js (versioned persistence) and profileChecks.js (save-time data
// checks), against the scripted database mock.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/connection.js');
vi.mock('../db/columnCache.js', () => ({ discoverExtendedAttrKeys: vi.fn() }));
import { query, queryOne } from '../db/connection.js';
import { discoverExtendedAttrKeys } from '../db/columnCache.js';
import {
  isProfileId, listProfiles, getProfile, listVersions, createProfile, updateProfile,
} from './profileStore.js';
import { checkAgainstData, estimateRows, measureDistinct } from './profileChecks.js';
import { validateDefinition } from './profileSchema.js';
import { resolveField } from './fields.js';

const ID = '3f1c2a9e-6b1d-4c2e-9a7b-1234567890ab';
const PROFILE = { name: 'W', description: null, status: 'active', definition: { dimensions: [] } };

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  discoverExtendedAttrKeys.mockReset();
});

describe('profileStore', () => {
  it('only treats UUIDs as profile ids - no cast error reaches the database', async () => {
    expect(isProfileId(ID)).toBe(true);
    expect(isProfileId('1; DROP')).toBe(false);
    expect(await getProfile('42')).toBeNull();
    expect(await listVersions('42')).toEqual([]);
    expect(queryOne).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('lists and reads profiles', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: ID }] });
    expect(await listProfiles()).toEqual([{ id: ID }]);
    queryOne.mockResolvedValueOnce({ id: ID, version: 2 });
    expect(await getProfile(ID)).toEqual({ id: ID, version: 2 });
    query.mockResolvedValueOnce({ rows: [{ version: 2 }, { version: 1 }] });
    expect(await listVersions(ID)).toEqual([{ version: 2 }, { version: 1 }]);
  });

  it('creates version 1 and appends it to the version trail in the same transaction', async () => {
    const row = { id: ID, version: 1, name: 'W', status: 'active', definition: PROFILE.definition };
    query.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [] });
    expect(await createProfile(PROFILE, 'ann@x')).toEqual(row);
    const [insertVersion, params] = query.mock.calls[1];
    expect(insertVersion).toContain('INSERT INTO "AnalyticsProfileVersions"');
    expect(params).toEqual([ID, 1, 'W', 'active', JSON.stringify(PROFILE.definition), 'ann@x']);
  });

  it('turns a duplicate name into a 409, and passes other errors through', async () => {
    query.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    await expect(createProfile(PROFILE, 'a')).rejects.toMatchObject({ status: 409, code: 'name_taken' });
    query.mockRejectedValueOnce(new Error('boom'));
    await expect(createProfile(PROFILE, 'a')).rejects.toThrow('boom');
  });

  it('updates only the version the caller edited, and appends the new version', async () => {
    const row = { id: ID, version: 4, name: 'W', status: 'active', definition: {} };
    query.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [] });
    expect(await updateProfile(ID, PROFILE, 3, 'ann')).toEqual(row);
    expect(query.mock.calls[0][0]).toContain('"version" = "version" + 1');
    expect(query.mock.calls[0][1].at(-1)).toBe(3);
    expect(query.mock.calls[1][1].slice(0, 2)).toEqual([ID, 4]);
  });

  it('tells a stale write as 409 with the current version from a missing profile as 404', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ version: 5 }] });
    await expect(updateProfile(ID, PROFILE, 3, 'a')).rejects.toMatchObject({ status: 409, code: 'version_conflict', details: { currentVersion: 5 } });
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expect(updateProfile(ID, PROFILE, 3, 'a')).rejects.toMatchObject({ status: 404 });
    await expect(updateProfile('nope', PROFILE, 3, 'a')).rejects.toMatchObject({ status: 404 });
  });
});

describe('profileChecks', () => {
  const def = over => validateDefinition({
    dimensions: [{ field: 'Principal.accountEnabled' }, { field: 'Principal.ext.tier' }, { field: 'Identity.department' }],
    datasets: [{ id: 'a', metric: 'principals.count', dimensions: ['Principal.accountEnabled', 'Principal.ext.tier', 'Identity.department'] }],
    ...over,
  }).definition;

  it('refuses scope systems that do not exist, naming them', async () => {
    discoverExtendedAttrKeys.mockResolvedValue(['tier']);
    query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
    const r = await checkAgainstData(def({ scope: { systemIds: [1, 2, 3] } }));
    expect(r.errors).toEqual([{ path: 'scope.systemIds', code: 'unknown_system', message: 'No such system: 2, 3' }]);
    expect(r.preview).toBeNull();
    expect(queryOne).not.toHaveBeenCalled();     // nothing is measured over a broken scope
  });

  it('refuses a discovered attribute this install has never seen', async () => {
    discoverExtendedAttrKeys.mockResolvedValue(['userType']);
    const r = await checkAgainstData(def());
    expect(r.errors.map(e => [e.path, e.code])).toEqual([['dimensions[1].field', 'unknown_field']]);
    expect(queryOne).not.toHaveBeenCalled();     // no cardinality queries once a field is unknown
  });

  it('measures every dimension, refuses one above the cap, and previews the row bound', async () => {
    discoverExtendedAttrKeys.mockResolvedValue(['tier']);
    queryOne.mockResolvedValueOnce({ n: 2 }).mockResolvedValueOnce({ n: 200 }).mockResolvedValueOnce({ n: 201 });
    const r = await checkAgainstData(def());
    expect(r.errors.map(e => [e.path, e.code])).toEqual([['dimensions[2].field', 'high_cardinality']]);
    expect(r.preview.dimensions).toEqual([
      { field: 'Principal.accountEnabled', distinctValues: 2, bounded: true },
      { field: 'Principal.ext.tier', distinctValues: 200, bounded: false },
      { field: 'Identity.department', distinctValues: 201, bounded: false },
    ]);
  });

  it('warns - does not refuse - when the bound exceeds maxRows', async () => {
    discoverExtendedAttrKeys.mockResolvedValue(['tier']);
    queryOne.mockResolvedValue({ n: 10 });
    const r = await checkAgainstData(def({ limits: { maxRows: 1000 } }));
    expect(r.errors).toEqual([]);
    // (10+1) × (10+1) × (10+3): the identity field also has "(not linked)" and "(multiple identities)".
    expect(r.preview.datasets).toEqual([{ id: 'a', estimatedMaxRows: 1573 }]);
    expect(r.warnings.map(w => w.code)).toEqual(['may_exceed_max_rows']);
  });

  it('estimates 1 cell for a dataset without dimensions', () => {
    expect(estimateRows({ dimensions: [] }, [])).toBe(1);
  });

  it('measures distinct values over the population the dataset counts, capped at limit plus 1', async () => {
    queryOne.mockResolvedValueOnce({ n: 7 });
    expect(await measureDistinct(resolveField('Identity.department'), { systemIds: [4] }, 50)).toBe(7);
    const [sql, params] = queryOne.mock.calls[0];
    expect(sql).toContain('FROM "Identities" i WHERE EXISTS');
    expect(params).toEqual(['#microsoft.graph.group', [4], 51]);
    queryOne.mockResolvedValueOnce(null);
    expect(await measureDistinct(resolveField('Resource.resourceType'), { systemIds: null })).toBe(0);
    expect(queryOne.mock.calls[1][0]).toContain('FROM "Resources" r WHERE r."deletedAt" IS NULL');
  });
});
