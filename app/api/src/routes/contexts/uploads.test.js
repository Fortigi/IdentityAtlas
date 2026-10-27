// Route tests for /api/contexts/uploads — the gate, the file intake and the
// mapping of failures to answers. The steps themselves are service.test.js's.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouterAs } from '../../../test-utils/routeTestKit.js';

// A gate that really gates: the caller needs one of the required permissions.
const gateCalls = [];
vi.mock('../../middleware/auth.js', () => ({
  requirePermission: (...required) => {
    gateCalls.push(required);
    return (req, res, next) => (required.some(p => req.user?.permissions?.includes(p)) ? next() : res.status(403).json({ error: 'Insufficient permissions' }));
  },
}));
vi.mock('../../db/connection.js');
vi.mock('../../contexts/upload/service.js', async (orig) => ({
  ...(await orig()),
  analyzeUpload: vi.fn(), previewUpload: vi.fn(), applyUpload: vi.fn(),
}));
vi.mock('../../contexts/upload/lists.js', async (orig) => ({ ...(await orig()), listLists: vi.fn() }));
process.env.USE_SQL = 'true';

const { default: router, sendFailure, MAX_UPLOAD_BYTES } = await import('./uploads.js');
const service = await import('../../contexts/upload/service.js');
const { listLists } = await import('../../contexts/upload/lists.js');
const { ListParseError } = await import('../../contexts/upload/parse.js');

const analyst = { email: 'analyst@x.nl', permissions: ['data.write.contexts'] };
const reader = { email: 'reader@x.nl', permissions: ['data.read'] };
let caller = analyst;
const app = mountRouterAs(router, () => caller);

beforeEach(() => {
  caller = analyst;
  vi.mocked(service.analyzeUpload).mockReset();
  vi.mocked(service.previewUpload).mockReset();
  vi.mocked(service.applyUpload).mockReset();
  vi.mocked(listLists).mockReset();
});

describe('the gate', () => {
  it('is the contexts write gate (data.write.contexts)', () => {
    // shared.js builds writeContexts once; the four 403s below show every route is behind it.
    expect(gateCalls).toEqual([['data.write.contexts', 'admin.context-plugins']]);
  });

  it.each([
    ['get', '/api/contexts/uploads'],
    ['post', '/api/contexts/uploads/preview'],
    ['post', '/api/contexts/uploads/apply'],
    ['post', '/api/contexts/uploads/analyze'],
  ])('%s %s is 403 for a reader and reaches nothing', async (method, path) => {
    caller = reader;
    expect((await request(app)[method](path).send({})).status).toBe(403);
    expect(service.applyUpload).not.toHaveBeenCalled();
    expect(listLists).not.toHaveBeenCalled();
  });
});

describe('GET /contexts/uploads', () => {
  it('lists the uploaded lists', async () => {
    vi.mocked(listLists).mockResolvedValue([{ id: 1, displayName: 'Klanten (upload)' }]);
    const res = await request(app).get('/api/contexts/uploads');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [{ id: 1, displayName: 'Klanten (upload)' }] });
  });

  it('answers a database failure with a generic 500', async () => {
    vi.mocked(listLists).mockRejectedValue(new Error('relation "x" does not exist'));
    const res = await request(app).get('/api/contexts/uploads');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Listing uploaded lists failed');
  });
});

describe('POST /contexts/uploads/analyze', () => {
  it('hands the file, its name, the caller and the list to the service', async () => {
    vi.mocked(service.analyzeUpload).mockResolvedValue({ uploadDraftId: 'd' });
    const res = await request(app).post('/api/contexts/uploads/analyze')
      .field('listId', '7').attach('file', Buffer.from('Naam\nAcme'), 'klanten.csv');
    expect(res.status).toBe(200);
    const [input] = vi.mocked(service.analyzeUpload).mock.calls[0];
    expect(input).toMatchObject({ fileName: 'klanten.csv', uploadedBy: 'analyst@x.nl', listId: '7' });
    expect(input.buffer.toString()).toBe('Naam\nAcme');
  });

  it('400 without a file, and for a file type that is not a list', async () => {
    expect((await request(app).post('/api/contexts/uploads/analyze').field('listId', '7')).body.error).toMatch(/Choose a file/);
    const res = await request(app).post('/api/contexts/uploads/analyze').attach('file', Buffer.from('x'), 'evil.exe');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Upload a .csv or .xlsx file.');
    expect(service.analyzeUpload).not.toHaveBeenCalled();
  });

  it('a list the parser refuses is a 400 with its sentence', async () => {
    vi.mocked(service.analyzeUpload).mockRejectedValue(new ListParseError('The file is empty.'));
    const res = await request(app).post('/api/contexts/uploads/analyze').attach('file', Buffer.from('x'), 'k.csv');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'The file is empty.' });
  });

  it('the size bound sits far above any 50,000-row list', () => {
    expect(MAX_UPLOAD_BYTES).toBe(200 * 1024 * 1024);
  });
});

describe('POST /contexts/uploads/preview and /apply', () => {
  it('preview passes the body through', async () => {
    vi.mocked(service.previewUpload).mockResolvedValue({ contexts: { created: 1 } });
    const res = await request(app).post('/api/contexts/uploads/preview').send({ uploadDraftId: 'd', mapping: {} });
    expect(res.status).toBe(200);
    expect(vi.mocked(service.previewUpload).mock.calls[0][0]).toEqual({ uploadDraftId: 'd', mapping: {} });
  });

  it('apply answers 201 and stamps the caller as the uploader', async () => {
    vi.mocked(service.applyUpload).mockResolvedValue({ rootContextId: 'r' });
    const res = await request(app).post('/api/contexts/uploads/apply').send({ uploadDraftId: 'd', mapping: {} });
    expect(res.status).toBe(201);
    expect(vi.mocked(service.applyUpload).mock.calls[0][1]).toBe('analyst@x.nl');
    expect(Object.keys(vi.mocked(service.applyUpload).mock.calls[0][2]).sort())
      .toEqual(['db', 'insertOwnerRows', 'insertRelationshipRows', 'insertRoleRows', 'refreshMemberCounts', 'runIngest']);
  });

  it('an UploadError keeps its status and details', async () => {
    vi.mocked(service.applyUpload).mockRejectedValue(new service.UploadError(409, 'Taken', ['x']));
    const res = await request(app).post('/api/contexts/uploads/apply').send({});
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Taken', details: ['x'] });
  });
});

describe('sendFailure', () => {
  it('leaves details out when there are none', () => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    sendFailure(res, new service.UploadError(410, 'Gone'), 'x');
    expect(res.status).toHaveBeenCalledWith(410);
    expect(res.json).toHaveBeenCalledWith({ error: 'Gone' });
  });
});
