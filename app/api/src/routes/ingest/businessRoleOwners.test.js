import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

process.env.USE_SQL = 'true';

vi.mock('../../db/connection.js');
import { query } from '../../db/connection.js';
const mocks = vi.hoisted(() => ({
  matchAll: vi.fn(), isFeatureEnabled: vi.fn(), setBusinessRoleOwner: vi.fn(),
}));
vi.mock('../../contexts/upload/members.js', () => ({ matchAll: mocks.matchAll }));
vi.mock('../../featureFlags.js', () => ({ isFeatureEnabled: mocks.isFeatureEnabled }));
vi.mock('../../lib/businessRoleOwners.js', () => ({
  OWNER_ROLES: ['Accountable', 'Responsible'],
  setBusinessRoleOwner: mocks.setBusinessRoleOwner,
}));

const { default: router, parseOwnerRecords } = await import('./businessRoleOwners.js');

function appAs(crawler) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.crawler = crawler; next(); });
  app.use('/api', router);
  return app;
}

const CRAWLER = { permissions: ['ingest'], systemIds: [1] };
const REC = { resourceExternalId: 'ext-1', role: 'Accountable', holder: 'u1', holderName: 'Ann' };
const post = (body, crawler = CRAWLER) => request(appAs(crawler)).post('/api/ingest/business-role-owners').send(body);
const people = (entries) => mocks.matchAll.mockResolvedValue({ ids: { Principal: new Map(entries) }, stats: {} });

beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [{ id: 'role-1', externalId: 'ext-1', systemId: 1 }] });
  mocks.matchAll.mockReset();
  mocks.isFeatureEnabled.mockReset().mockResolvedValue(false);
  mocks.setBusinessRoleOwner.mockReset().mockResolvedValue({ id: 'o1' });
  people([['u1', 'p1']]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('parseOwnerRecords', () => {
  it('accepts a record and stringifies its keys', () => {
    expect(parseOwnerRecords([{ resourceExternalId: 7, role: 'Responsible', holder: 9 }]).rows[0])
      .toEqual({ resourceExternalId: '7', role: 'Responsible', holder: '9', holderName: null });
  });

  it.each([
    [{ role: 'Accountable', holder: 'u' }, /resourceExternalId/],
    [{ resourceExternalId: 'x', role: 'Owner', holder: 'u' }, /role must be/],
    [{ resourceExternalId: 'x', role: 'Accountable' }, /holder/],
    [null, /resourceExternalId/],
  ])('rejects %j, naming the record', (rec, message) => {
    const out = parseOwnerRecords([REC, rec]);
    expect(out.status).toBe(400);
    expect(out.message).toMatch(/^records\[1\]/);
    expect(out.message).toMatch(message);
  });
});

describe('POST /ingest/business-role-owners — gates', () => {
  it('403 without the ingest permission', async () => {
    expect((await post({ systemId: 1, records: [REC] }, { permissions: [], systemIds: [1] })).status).toBe(403);
  });

  it('403 for a system the key may not write', async () => {
    expect((await post({ systemId: 2, records: [REC] })).status).toBe(403);
    expect(mocks.setBusinessRoleOwner).not.toHaveBeenCalled();
  });

  it('400 on a bad envelope or record', async () => {
    expect((await post({ records: [REC] })).status).toBe(400);
    expect((await post({ systemId: 1, records: [{ role: 'x' }] })).status).toBe(400);
  });

  it('500 with a generic message when the write fails', async () => {
    query.mockRejectedValue(new Error('secret'));
    const res = await post({ systemId: 1, records: [REC] });
    expect(res.status).toBe(500);
    expect(res.body.error).not.toMatch(/secret/);
  });
});

describe('POST /ingest/business-role-owners — writing', () => {
  it('writes the owner as sync', async () => {
    const res = await post({ systemId: 1, records: [REC] });
    expect(res.body).toEqual({ written: 1, skipped: 0, unmatched: 0 });
    expect(mocks.setBusinessRoleOwner).toHaveBeenCalledWith('role-1', { role: 'Accountable', holderCol: 'principalId', holderId: 'p1' }, 'sync');
  });

  it('counts a place it may not take as skipped', async () => {
    mocks.setBusinessRoleOwner.mockResolvedValue(null);
    expect((await post({ systemId: 1, records: [REC] })).body).toEqual({ written: 0, skipped: 1, unmatched: 0 });
  });

  it('does not touch a role in a system the key may not write', async () => {
    query.mockResolvedValue({ rows: [{ id: 'role-9', externalId: 'ext-1', systemId: 9 }] });
    expect((await post({ systemId: 1, records: [REC] })).body).toEqual({ written: 0, skipped: 0, unmatched: 1 });
    expect(mocks.setBusinessRoleOwner).not.toHaveBeenCalled();
  });

  it('allows any system for an unrestricted key', async () => {
    query.mockResolvedValue({ rows: [{ id: 'role-9', externalId: 'ext-1', systemId: 9 }] });
    const res = await post({ systemId: 1, records: [REC] }, { permissions: ['ingest'], systemIds: null });
    expect(res.body.written).toBe(1);
  });

  it('skips an external id two writable roles share', async () => {
    query.mockResolvedValue({ rows: [{ id: 'a', externalId: 'ext-1', systemId: 1 }, { id: 'b', externalId: 'ext-1', systemId: 1 }] });
    expect((await post({ systemId: 1, records: [REC] })).body.unmatched).toBe(1);
  });

  it('counts an unknown holder as unmatched', async () => {
    people([]);
    expect((await post({ systemId: 1, records: [REC] })).body.unmatched).toBe(1);
  });
});

describe('matching a holder by name is opt-in', () => {
  it('ignores the name when the setting is off', async () => {
    people([['Ann', 'p-name']]);
    const res = await post({ systemId: 1, records: [REC] });
    expect(mocks.matchAll.mock.calls[0][1].Principal).toEqual(['u1']);
    expect(res.body.unmatched).toBe(1);
  });

  it('uses the name when the setting is on and the key finds nobody', async () => {
    mocks.isFeatureEnabled.mockResolvedValue(true);
    people([['Ann', 'p-name']]);
    await post({ systemId: 1, records: [REC] });
    expect(mocks.isFeatureEnabled).toHaveBeenCalledWith('sourceOwnerNameMatch');
    expect(mocks.setBusinessRoleOwner.mock.calls[0][1].holderId).toBe('p-name');
  });

  it('prefers the key over the name', async () => {
    mocks.isFeatureEnabled.mockResolvedValue(true);
    people([['u1', 'p-key'], ['Ann', 'p-name']]);
    await post({ systemId: 1, records: [REC] });
    expect(mocks.setBusinessRoleOwner.mock.calls[0][1].holderId).toBe('p-key');
  });
});
