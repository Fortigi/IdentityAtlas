import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouterAs } from '../../../test-utils/routeTestKit.js';

vi.mock('../../db/connection.js');
vi.mock('../propose/service.js', () => ({ propose: vi.fn(), warmupState: vi.fn(() => 'cold') }));
vi.mock('../import/sourceStore.js', () => ({ getSourceWithContent: vi.fn(), readSourceTable: vi.fn() }));
vi.mock('../propose/probe.js', async (importOriginal) => ({ ...(await importOriginal()), loadProbeTargets: vi.fn() }));
vi.mock('../../nlreports/assistantHttp.js', async (importOriginal) => ({
  ...(await importOriginal()),
  generatorStatus: vi.fn(),
}));
const authEnabled = vi.fn(() => false);
vi.mock('../../config/authConfig.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isAuthEnabled: () => authEnabled(),
}));

import { queryOne } from '../../db/connection.js';
import { propose, warmupState } from '../propose/service.js';
import { generatorStatus } from '../../nlreports/assistantHttp.js';
import { getSourceWithContent, readSourceTable } from '../import/sourceStore.js';
import { loadProbeTargets, buildTargets } from '../propose/probe.js';
import router, { parseProposeRequest, MAX_COLUMNS } from './propose.js';

let perms = new Set(['*']);
const app = mountRouterAs(router, () => ({ email: 'analyst@contoso.com', permissions: perms }));

const columns = [{ name: 'Code', nonEmpty: 3, distinct: 3, uniqueness: 1, shape: 'text', samples: ['A'] }];
const proposal = { recipe: { version: 1, entities: [], relations: [] }, linkRules: [], notes: [], origin: 'heuristic', timing: { ms: 3, model: false } };

beforeEach(() => {
  vi.clearAllMocks();
  queryOne.mockResolvedValue(undefined);
  process.env.FEATURE_ORG_TRUTH = 'true';
  process.env.NL_REPORTS_LLM_URL = 'http://report-generator:8080';
  authEnabled.mockReturnValue(false);
  perms = new Set(['*']);
  propose.mockResolvedValue(proposal);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('GET /org-truth/propose/status', () => {
  it('reports the generator and this prompt\'s warm-up when a model server is configured', async () => {
    generatorStatus.mockResolvedValueOnce({ available: true, model: 'm', loaded: true, promptCache: 'ready', reason: null });
    const r = await request(app).get('/api/org-truth/propose/status');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ configured: true, available: true, model: 'm', loaded: true, promptCache: 'ready', reason: null });
    expect(generatorStatus).toHaveBeenCalledWith(warmupState);
  });

  it('says "not configured" without contacting anything when no model server is set', async () => {
    delete process.env.NL_REPORTS_LLM_URL;
    const r = await request(app).get('/api/org-truth/propose/status');
    expect(r.body).toEqual({ configured: false, available: false, model: null, loaded: false, promptCache: 'cold', reason: 'not-configured' });
    expect(generatorStatus).not.toHaveBeenCalled();
  });

  it('is readable with data.read alone', async () => {
    authEnabled.mockReturnValue(true);
    perms = new Set(['data.read']);
    generatorStatus.mockResolvedValueOnce({ available: false });
    expect((await request(app).get('/api/org-truth/propose/status')).status).toBe(200);
  });
});

describe('POST /org-truth/propose/recipe', () => {
  it('proposes from a column profile and answers the proposal', async () => {
    const r = await request(app).post('/api/org-truth/propose/recipe').send({ fileName: 'Assets.xlsx', columns, rowCount: 3 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual(proposal);
    expect(propose).toHaveBeenCalledWith({
      fileName: 'Assets.xlsx', rowCount: 3,
      columns: [{ name: 'Code', index: 0, nonEmpty: 3, distinct: 3, uniqueness: 1, shape: 'text', samples: ['A'] }],
    });
    expect(console.log).toHaveBeenCalledWith('org-truth propose: user=analyst@contoso.com file="Assets.xlsx" columns=1 origin=heuristic ms=3');
  });

  it('answers 400 for a bad profile, without proposing', async () => {
    expect((await request(app).post('/api/org-truth/propose/recipe').send({ columns: [] })).status).toBe(400);
    expect(propose).not.toHaveBeenCalled();
  });

  it('a stored source alone: reads its rows, profiles them, probes the values and proposes from the data', async () => {
    getSourceWithContent.mockResolvedValueOnce({ id: 'src-1', fileName: 'Uren.xlsx', displayName: 'Hours' });
    // a timesheet: no column unique on its own, Month + Person together are
    readSourceTable.mockResolvedValueOnce({
      columns: ['Month', 'Person', 'Customer'],
      rows: [
        { Month: 'jan', Person: 'Ann Example', Customer: 'Contoso' },
        { Month: 'jan', Person: 'Bob Example', Customer: 'Contoso' },
        { Month: 'feb', Person: 'Ann Example', Customer: 'Contoso' },
      ],
    });
    loadProbeTargets.mockResolvedValueOnce(buildTargets(
      [{ displayName: 'Ann Example' }, { displayName: 'Bob Example' }], [], [{ displayName: 'Contoso B.V.', entityType: 'Customer' }],
    ));
    const r = await request(app).post('/api/org-truth/propose/recipe').send({ sourceId: 'src-1' });
    expect(r.status).toBe(200);
    expect(getSourceWithContent).toHaveBeenCalledWith('src-1');
    const input = propose.mock.calls[0][0];
    expect(input.fileName).toBe('Uren.xlsx');
    expect(input.rowCount).toBe(3);
    expect(input.columns.map(c => c.name)).toEqual(['Month', 'Person', 'Customer']);
    expect(input.probes.Person).toMatchObject({ values: 2, people: 1, orgEntities: 0 });
    expect(input.probes.Customer).toMatchObject({ values: 1, people: 0, orgEntities: 1, orgEntityTypes: ['Customer'] });
    expect(input.compositeKey).toEqual(['Month', 'Person']);
    expect(console.log).toHaveBeenCalledWith('org-truth propose: user=analyst@contoso.com file="Uren.xlsx" columns=3 origin=heuristic ms=3');
  });

  it('a stored source with a profile: probes too, keeps the sent file name and finds no composite key when one column is a key', async () => {
    getSourceWithContent.mockResolvedValueOnce({ id: 'src-2', fileName: 'other.csv' });
    readSourceTable.mockResolvedValueOnce({ columns: ['Code'], rows: [{ Code: 'A' }, { Code: 'B' }] });
    loadProbeTargets.mockResolvedValueOnce(buildTargets([], [{ displayName: 'A' }], []));
    const r = await request(app).post('/api/org-truth/propose/recipe').send({ sourceId: 'src-2', fileName: 'Assets.xlsx', columns });
    expect(r.status).toBe(200);
    const input = propose.mock.calls[0][0];
    expect(input.fileName).toBe('Assets.xlsx');
    expect(input.columns).toEqual([{ name: 'Code', index: 0, nonEmpty: 3, distinct: 3, uniqueness: 1, shape: 'text', samples: ['A'] }]);
    expect(input.rowCount).toBe(2);
    expect(input.probes.Code).toMatchObject({ values: 2, resources: 0.5 });
    expect(input.compositeKey).toBeNull();
  });

  it('a stored source falls back to its display name, then to nothing', async () => {
    getSourceWithContent.mockResolvedValueOnce({ id: 'src-3', displayName: 'Hours list' }).mockResolvedValueOnce({ id: 'src-4' });
    readSourceTable.mockResolvedValue({ columns: ['Code'], rows: [{ Code: 'A' }] });
    loadProbeTargets.mockResolvedValue(buildTargets([], [], []));
    await request(app).post('/api/org-truth/propose/recipe').send({ sourceId: 'src-3' });
    await request(app).post('/api/org-truth/propose/recipe').send({ sourceId: 'src-4' });
    expect(propose.mock.calls.map(c => c[0].fileName)).toEqual(['Hours list', '']);
  });

  it('answers 404 for an unknown stored source, without proposing', async () => {
    getSourceWithContent.mockResolvedValueOnce(null);
    const r = await request(app).post('/api/org-truth/propose/recipe').send({ sourceId: 'nope' });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'Source not found.' });
    expect(propose).not.toHaveBeenCalled();
    expect(readSourceTable).not.toHaveBeenCalled();
  });

  it('without a sourceId reads no source and sends no probes', async () => {
    await request(app).post('/api/org-truth/propose/recipe').send({ columns });
    expect(getSourceWithContent).not.toHaveBeenCalled();
    expect(propose.mock.calls[0][0]).not.toHaveProperty('probes');
  });
  it('answers 500 with a generic message when the proposal throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    propose.mockRejectedValueOnce(new Error('boom'));
    const r = await request(app).post('/api/org-truth/propose/recipe').send({ columns });
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'Request failed' });
    expect(errSpy).toHaveBeenCalledWith('org-truth propose failed:', 'boom');
  });

  it('answers 403 without data.write.contexts, even with data.read', async () => {
    authEnabled.mockReturnValue(true);
    perms = new Set(['data.read']);
    const r = await request(app).post('/api/org-truth/propose/recipe').send({ columns });
    expect(r.status).toBe(403);
    expect(propose).not.toHaveBeenCalled();
    perms = new Set(['data.write.contexts']);
    expect((await request(app).post('/api/org-truth/propose/recipe').send({ columns })).status).toBe(200);
  });
});

describe('the feature flag', () => {
  it('hides both routes (404) while orgTruth is off', async () => {
    process.env.FEATURE_ORG_TRUTH = 'false';
    expect((await request(app).get('/api/org-truth/propose/status')).status).toBe(404);
    expect((await request(app).post('/api/org-truth/propose/recipe').send({ columns })).status).toBe(404);
    expect(propose).not.toHaveBeenCalled();
  });
});

describe('parseProposeRequest', () => {
  it('cleans each column: counts, shape, samples, index', () => {
    const r = parseProposeRequest({
      fileName: 'f'.repeat(300),
      rowCount: -1,
      columns: [{ name: 'A', index: 7, nonEmpty: '4', distinct: -2, uniqueness: 3, shape: 'weird', samples: [1, null, 'x'.repeat(300), 'd', 'e', 'f'] }],
    });
    expect(r.fileName).toHaveLength(256);
    expect(r).not.toHaveProperty('rowCount');
    expect(r.columns).toEqual([{ name: 'A', index: 7, nonEmpty: 4, distinct: 0, uniqueness: 1, shape: 'text', samples: ['1', '', 'x'.repeat(200), 'd', 'e'] }]);
  });

  it('defaults a missing file name and a non-array samples list', () => {
    const r = parseProposeRequest({ columns: [{ name: 'A', shape: 'email', samples: 'x' }] });
    expect(r).toEqual({ fileName: '', columns: [{ name: 'A', index: 0, nonEmpty: 0, distinct: 0, uniqueness: 0, shape: 'email', samples: [] }] });
  });

  it('refuses missing, empty, oversized or nameless column lists', () => {
    const tooMany = Array.from({ length: MAX_COLUMNS + 1 }, (_, i) => ({ name: `C${i}` }));
    for (const body of [undefined, {}, { columns: 'x' }, { columns: [] }, { columns: tooMany }]) {
      expect(parseProposeRequest(body)).toEqual({ error: `columns must be a list of 1 to ${MAX_COLUMNS} column profiles` });
    }
    for (const bad of [null, 'A', { name: '' }, { name: '  ' }, { name: 5 }, { name: 'n'.repeat(257) }]) {
      expect(parseProposeRequest({ columns: [{ name: 'ok' }, bad] })).toEqual({ error: 'Every column needs a name of at most 256 characters' });
    }
    expect(parseProposeRequest({ columns: Array.from({ length: MAX_COLUMNS }, (_, i) => ({ name: `C${i}` })) }).columns).toHaveLength(MAX_COLUMNS);
  });

  it('prefers the profile when both a sourceId and columns are sent', () => {
    const both = parseProposeRequest({ sourceId: 'x', columns: [{ name: 'A' }] });
    expect(both.columns).toHaveLength(1);
    expect(both.sourceId).toBe('x');
    expect(both).not.toHaveProperty('sourceOnly');
    expect(parseProposeRequest({ sourceId: 'x' })).toEqual({ sourceOnly: true, sourceId: 'x' });
    // a non-string sourceId next to a profile is dropped
    expect(parseProposeRequest({ sourceId: 5, columns: [{ name: 'A' }] })).not.toHaveProperty('sourceId');
  });
});
