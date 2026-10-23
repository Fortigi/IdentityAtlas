// Route tests for /api/contexts/:id/activity — the gates (write vs read), the id
// checks, the file intake and the mapping of failures to answers. The steps
// themselves are contexts/activity/*.test.js's.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouterAs } from '../../../test-utils/routeTestKit.js';

vi.mock('../../middleware/auth.js', () => ({
  requirePermission: (...required) => (req, res, next) => (required.some(p => req.user?.permissions?.includes(p)) ? next() : res.status(403).json({ error: 'Insufficient permissions' })),
}));
vi.mock('../../db/connection.js');
vi.mock('../../contexts/activity/service.js', async (orig) => ({ ...(await orig()), analyzeActivity: vi.fn(), previewActivity: vi.fn(), applyActivity: vi.fn() }));
vi.mock('../../contexts/activity/view.js', async (orig) => ({ ...(await orig()), contextActivity: vi.fn(), activitySummary: vi.fn() }));
vi.mock('../../contexts/activity/store.js', async (orig) => ({ ...(await orig()), listUploads: vi.fn(), deleteUpload: vi.fn() }));
process.env.USE_SQL = 'true';

const { default: router } = await import('./activity.js');
const service = await import('../../contexts/activity/service.js');
const view = await import('../../contexts/activity/view.js');
const store = await import('../../contexts/activity/store.js');
const { UploadError } = await import('../../contexts/upload/service.js');

const ID = '0a1b2c3d-0000-4000-8000-000000000001';
const UPLOAD = '0a1b2c3d-0000-4000-8000-0000000000ff';
const analyst = { email: 'analyst@example.org', permissions: ['data.write.contexts'] };
const business = { email: 'reader@example.org', permissions: ['data.read'] };
const nobody = { email: 'none@example.org', permissions: [] };
let caller = analyst;
const app = mountRouterAs(router, () => caller);

beforeEach(() => {
  caller = analyst;
  for (const fn of [service.analyzeActivity, service.previewActivity, service.applyActivity, view.contextActivity, view.activitySummary, store.listUploads, store.deleteUpload]) {
    vi.mocked(fn).mockReset();
  }
});

describe('the gates', () => {
  it.each([
    ['post', `/api/contexts/${ID}/activity/analyze`],
    ['post', `/api/contexts/${ID}/activity/preview`],
    ['post', `/api/contexts/${ID}/activity/apply`],
    ['delete', `/api/contexts/${ID}/activity/uploads/${UPLOAD}`],
  ])('%s %s is 403 for a business reader (data.read only)', async (method, path) => {
    caller = business;
    expect((await request(app)[method](path).send({})).status).toBe(403);
    expect(service.applyActivity).not.toHaveBeenCalled();
    expect(store.deleteUpload).not.toHaveBeenCalled();
  });

  it.each([
    `/api/contexts/${ID}/activity`,
    `/api/contexts/${ID}/activity/summary`,
    `/api/contexts/${ID}/activity/uploads`,
  ])('GET %s is open to a business reader and an analyst, closed without either', async (path) => {
    vi.mocked(view.contextActivity).mockResolvedValue({ period: null });
    vi.mocked(view.activitySummary).mockResolvedValue({ period: null });
    vi.mocked(store.listUploads).mockResolvedValue([]);
    caller = business;
    expect((await request(app).get(path)).status).toBe(200);
    caller = analyst;
    expect((await request(app).get(path)).status).toBe(200);
    caller = nobody;
    expect((await request(app).get(path)).status).toBe(403);
  });

  it('refuses a malformed context or upload id before anything runs', async () => {
    expect((await request(app).get('/api/contexts/not-a-uuid/activity')).status).toBe(400);
    expect((await request(app).delete(`/api/contexts/${ID}/activity/uploads/42`)).body.error).toBe('Invalid upload id');
    expect(view.contextActivity).not.toHaveBeenCalled();
    expect(store.deleteUpload).not.toHaveBeenCalled();
  });
});

describe('the upload steps', () => {
  it('analyze hands the file, its name, the caller and the context to the service', async () => {
    vi.mocked(service.analyzeActivity).mockResolvedValue({ uploadDraftId: 'd' });
    const res = await request(app).post(`/api/contexts/${ID}/activity/analyze`).attach('file', Buffer.from('User;Date\nVera;1-1-2026'), 'clockify.csv');
    expect(res.status).toBe(200);
    const [input] = vi.mocked(service.analyzeActivity).mock.calls[0];
    expect(input).toMatchObject({ fileName: 'clockify.csv', uploadedBy: 'analyst@example.org', contextId: ID });
    expect(input.buffer.toString()).toBe('User;Date\nVera;1-1-2026');
  });

  it('analyze without a file is a 400 and reaches nothing', async () => {
    const res = await request(app).post(`/api/contexts/${ID}/activity/analyze`);
    expect(res.status).toBe(400);
    expect(service.analyzeActivity).not.toHaveBeenCalled();
  });

  it('preview passes the body and the context through', async () => {
    vi.mocked(service.previewActivity).mockResolvedValue({ rowsToImport: 3 });
    const res = await request(app).post(`/api/contexts/${ID}/activity/preview`).send({ uploadDraftId: 'd', mapping: {} });
    expect(res.body).toEqual({ rowsToImport: 3 });
    expect(vi.mocked(service.previewActivity).mock.calls[0].slice(0, 2)).toEqual([{ uploadDraftId: 'd', mapping: {} }, ID]);
  });

  it('apply answers 201 with the caller as the uploader; an UploadError keeps its status and details', async () => {
    vi.mocked(service.applyActivity).mockResolvedValue({ uploadId: 'u' });
    const res = await request(app).post(`/api/contexts/${ID}/activity/apply`).send({ uploadDraftId: 'd' });
    expect(res.status).toBe(201);
    expect(vi.mocked(service.applyActivity).mock.calls[0][2]).toBe('analyst@example.org');
    vi.mocked(service.applyActivity).mockRejectedValue(new UploadError(400, 'The mapping is not complete.', ['Choose the date.']));
    const bad = await request(app).post(`/api/contexts/${ID}/activity/apply`).send({});
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'The mapping is not complete.', details: ['Choose the date.'] });
  });

  it('an unexpected failure is a generic 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(service.previewActivity).mockRejectedValue(new Error('column "x" does not exist'));
    const res = await request(app).post(`/api/contexts/${ID}/activity/preview`).send({});
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Previewing the activity upload failed' });
  });
});

describe('the reads and undo', () => {
  it('passes from and to through as strings, and drops a repeated parameter', async () => {
    vi.mocked(view.contextActivity).mockResolvedValue({ period: { from: '2026-01-01', to: '2026-03-31' } });
    await request(app).get(`/api/contexts/${ID}/activity?from=2026-01-01&to=2026-03-31`);
    expect(vi.mocked(view.contextActivity).mock.calls[0].slice(1)).toEqual([ID, { from: '2026-01-01', to: '2026-03-31', includeSubUnits: undefined }]);
    await request(app).get(`/api/contexts/${ID}/activity?includeSubUnits=false`);
    expect(vi.mocked(view.contextActivity).mock.calls[1][2]).toEqual({ from: undefined, to: undefined, includeSubUnits: 'false' });
    await request(app).get(`/api/contexts/${ID}/activity/summary?from=a&from=b`);
    expect(vi.mocked(view.activitySummary).mock.calls[0][2]).toEqual({ from: undefined, to: undefined });
  });

  it('lists the uploads as data', async () => {
    vi.mocked(store.listUploads).mockResolvedValue([{ id: UPLOAD }]);
    expect((await request(app).get(`/api/contexts/${ID}/activity/uploads`)).body).toEqual({ data: [{ id: UPLOAD }] });
  });

  it('undo removes an upload of this context, and is a 404 for one that is not', async () => {
    vi.mocked(store.deleteUpload).mockResolvedValueOnce({ id: UPLOAD, rows: 12 }).mockResolvedValueOnce(null);
    const ok = await request(app).delete(`/api/contexts/${ID}/activity/uploads/${UPLOAD}`);
    expect(ok.body).toEqual({ uploadId: UPLOAD, rowsRemoved: 12 });
    expect(vi.mocked(store.deleteUpload).mock.calls[0].slice(1)).toEqual([ID, UPLOAD]);
    expect((await request(app).delete(`/api/contexts/${ID}/activity/uploads/${UPLOAD}`)).status).toBe(404);
  });

  it.each([
    ['get', '/activity', () => view.contextActivity, 'Reading the activity failed'],
    ['get', '/activity/summary', () => view.activitySummary, 'Reading the activity summary failed'],
    ['get', '/activity/uploads', () => store.listUploads, 'Listing the activity uploads failed'],
    ['delete', `/activity/uploads/${UPLOAD}`, () => store.deleteUpload, 'Undoing the activity upload failed'],
  ])('%s %s answers an unexpected failure with a generic 500', async (method, path, fn, message) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fn()).mockRejectedValue(new Error('relation does not exist'));
    const res = await request(app)[method](`/api/contexts/${ID}${path}`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: message });
  });

  it('analyze answers a file the service cannot read with its sentence', async () => {
    const { ListParseError } = await import('../../contexts/upload/parse.js');
    vi.mocked(service.analyzeActivity).mockRejectedValue(new ListParseError('The file is empty.'));
    const res = await request(app).post(`/api/contexts/${ID}/activity/analyze`).attach('file', Buffer.from('x'), 'a.csv');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'The file is empty.' });
  });

  it('a bad period from the view is a 400 with its sentence', async () => {
    vi.mocked(view.contextActivity).mockRejectedValue(new UploadError(400, 'The period starts after it ends.'));
    const res = await request(app).get(`/api/contexts/${ID}/activity?from=2026-03-01&to=2026-01-01`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('The period starts after it ends.');
  });
});
