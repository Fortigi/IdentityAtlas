import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouterAs } from '../../../test-utils/routeTestKit.js';

vi.mock('../../db/connection.js');
vi.mock('../propose/service.js', () => ({ propose: vi.fn(), warmupState: vi.fn(() => 'cold') }));
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

  it('answers 400 for a bad profile and 501 for a stored source, without proposing', async () => {
    expect((await request(app).post('/api/org-truth/propose/recipe').send({ columns: [] })).status).toBe(400);
    const stored = await request(app).post('/api/org-truth/propose/recipe').send({ sourceId: 'abc' });
    expect(stored.status).toBe(501);
    expect(stored.body.error).toMatch(/stored source is not built yet/);
    expect(propose).not.toHaveBeenCalled();
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
    expect(parseProposeRequest({ sourceId: 'x', columns: [{ name: 'A' }] }).columns).toHaveLength(1);
    expect(parseProposeRequest({ sourceId: 'x' }).status).toBe(501);
  });
});
