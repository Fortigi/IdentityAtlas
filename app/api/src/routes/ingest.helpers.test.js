// Tests for the helpers extracted from the generic ingest handler. The handler
// (one per entity endpoint) was CC 58; each phase is now a separately-importable
// function. Pure helpers are tested directly; the DB / session ones with mocks.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/connection.js', () => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock('../ingest/sessions.js', () => ({
  startSession: vi.fn(), continueSession: vi.fn(), endSession: vi.fn(), hasSession: vi.fn(),
}));

import * as db from '../db/connection.js';
import { startSession, endSession, hasSession } from '../ingest/sessions.js';
import { SOFT_DELETE_TABLES } from '../ingest/engine.js';
import {
  applyIngestDefaults, recoverSystemPrefix, buildScope, conflictFilterFor,
  discoverCoreColumns, handleSessionPath, applyDeleteByIds, lookupSystemIds, writeAuditLog,
} from './ingest.js';

const UUID = '11111111-1111-1111-1111-111111111111';

// ─── Pure helpers ──────────────────────────────────────────────────────────

describe('applyIngestDefaults', () => {
  it('normalises a null records list to an empty array', () => {
    const body = { records: null };
    applyIngestDefaults('principals', body);
    expect(body.records).toEqual([]);
  });
  it('defaults governed=false on assignment records that omit it', () => {
    const body = { records: [{}, { governed: true }] };
    applyIngestDefaults('resource-assignments', body);
    expect(body.records[0].governed).toBe(false);
    expect(body.records[1].governed).toBe(true);
  });
  it('derives governanceResource from resourceType on resources', () => {
    const body = { records: [{ resourceType: 'BusinessRole' }, { resourceType: 'Group' }] };
    applyIngestDefaults('resources', body);
    expect(body.records[0].governanceResource).toBe(true);
    expect(body.records[1].governanceResource).toBe(false);
  });
});

describe('recoverSystemPrefix', () => {
  it('strips the entity suffix to recover a hyphenated system prefix', () => {
    expect(recoverSystemPrefix('context-members', 'my-sys-context-members'))
      .toEqual({ idPrefix: 'my-sys-context-members', systemPrefix: 'my-sys' });
  });
  it('handles governance sub-paths (slash) and an empty prefix', () => {
    expect(recoverSystemPrefix('governance/catalogs', 'acme-catalogs').systemPrefix).toBe('acme');
    expect(recoverSystemPrefix('principals', '')).toEqual({ idPrefix: '', systemPrefix: '' });
  });
});

describe('buildScope', () => {
  it('projects only the allowed scope columns', () => {
    expect(buildScope({ systemId: 1, region: 'eu', secret: 'x' }, ['systemId', 'region']))
      .toEqual({ systemId: 1, region: 'eu' });
  });
  it('returns {} when no scope is supplied', () => {
    expect(buildScope(undefined, ['systemId'])).toEqual({});
  });
});

describe('conflictFilterFor', () => {
  it('maps assignment endpoints to their partial-index filter, else null', () => {
    expect(conflictFilterFor('resource-assignments')).toBe('"principalId" IS NOT NULL');
    expect(conflictFilterFor('resource-assignments-identity')).toBe('"identityId" IS NOT NULL');
    expect(conflictFilterFor('principals')).toBe(null);
  });
});

// ─── DB / session helpers (mocked) ──────────────────────────────────────────

describe('discoverCoreColumns', () => {
  it('camelCases the discovered snake_case column names', async () => {
    db.query.mockResolvedValue({ rows: [{ column_name: 'display_name' }, { column_name: 'is_enabled' }, { column_name: 'systemid' }] });
    expect(await discoverCoreColumns('principals')).toEqual(['displayName', 'isEnabled', 'systemid']);
  });
});

describe('handleSessionPath', () => {
  const ctx = { tableName: 't', keyColumns: ['id'], normalized: [], scope: {}, scopeDeleteFilter: null, conflictFilter: null };

  it('start → 201 session:started', async () => {
    startSession.mockResolvedValue({ syncId: 's1', inserted: 2, updated: 1 });
    const r = await handleSessionPath({ syncSession: 'start', systemId: 1 }, ctx);
    expect(r).toMatchObject({ status: 201, body: { syncId: 's1', session: 'started', inserted: 2 } });
  });
  it('continue with an unknown syncId → 400', async () => {
    hasSession.mockReturnValue(false);
    const r = await handleSessionPath({ syncSession: 'continue', syncId: 'nope' }, ctx);
    expect(r.status).toBe(400);
  });
  it('end → 200 session:completed with deleted count', async () => {
    hasSession.mockReturnValue(true);
    endSession.mockResolvedValue({ syncId: 's1', inserted: 0, updated: 0, deleted: 5, totalRecords: 10 });
    const r = await handleSessionPath({ syncSession: 'end', syncId: 's1' }, ctx);
    expect(r).toMatchObject({ status: 200, body: { session: 'completed', deleted: 5, totalRecords: 10 } });
  });
  it('returns null when the request is not a session command', async () => {
    expect(await handleSessionPath({}, ctx)).toBe(null);
  });
});

describe('applyDeleteByIds', () => {
  it('is a no-op (null) when there are no deletedIds', async () => {
    const result = { deleted: 0 };
    expect(await applyDeleteByIds({}, 't', result)).toBe(null);
    expect(result.deleted).toBe(0);
  });
  it('rejects a batch containing a non-UUID with 400', async () => {
    const r = await applyDeleteByIds({ deletedIds: [UUID, 'not-a-uuid'] }, 't', { deleted: 0 });
    expect(r.status).toBe(400);
  });
  it('soft-deletes (stamps deletedAt) for soft-delete tables and adds the count', async () => {
    db.query.mockResolvedValue({ rowCount: 2 });
    const softTable = [...SOFT_DELETE_TABLES][0];
    const result = { deleted: 1 };
    expect(await applyDeleteByIds({ deletedIds: [UUID] }, softTable, result)).toBe(null);
    expect(result.deleted).toBe(3);
    expect(db.query.mock.calls.at(-1)[0]).toMatch(/UPDATE .* SET "deletedAt"/);
  });
  it('hard-deletes for non-soft-delete tables', async () => {
    db.query.mockResolvedValue({ rowCount: 4 });
    const result = { deleted: 0 };
    await applyDeleteByIds({ deletedIds: [UUID] }, 'some_hard_table', result);
    expect(result.deleted).toBe(4);
    expect(db.query.mock.calls.at(-1)[0]).toMatch(/DELETE FROM/);
  });
});

describe('lookupSystemIds', () => {
  it('returns undefined for a non-systems entity', async () => {
    expect(await lookupSystemIds('principals', [{}])).toBeUndefined();
  });
  it('resolves system ids by tenantId + systemType', async () => {
    db.queryOne.mockResolvedValue({ id: 42 });
    expect(await lookupSystemIds('systems', [{ tenantId: 't', systemType: 'EntraID' }])).toEqual([42]);
  });
  it('returns undefined when nothing resolves', async () => {
    db.queryOne.mockResolvedValue(null);
    expect(await lookupSystemIds('systems', [{ displayName: 'X' }])).toBeUndefined();
  });
});

describe('writeAuditLog', () => {
  it('no-ops when the request has no authenticated crawler', () => {
    db.query.mockClear();
    writeAuditLog({}, { records: [] });
    expect(db.query).not.toHaveBeenCalled();
  });
  it('inserts a CrawlerAuditLog row for an authenticated crawler', () => {
    db.query.mockReturnValue(Promise.resolve({}));
    writeAuditLog({ crawler: { id: 'c1' }, originalUrl: '/api/ingest/principals', ip: '1.2.3.4' }, { records: [{}, {}] });
    expect(db.query).toHaveBeenCalled();
    expect(db.query.mock.calls.at(-1)[0]).toContain('CrawlerAuditLog');
  });
});

// ─── SEC-2026-09: per-system boundary helpers ───────────────────────────────

const { coerceSystemsSyncMode, deleteOwnershipClause } = await import('./ingest/helpers.js');

describe('coerceSystemsSyncMode (C-01)', () => {
  it('runs a full sync of systems as a delta — systems are registered, never reconciled', () => {
    const body = { syncMode: 'full', records: [] };
    expect(coerceSystemsSyncMode('systems', body)).toBe(true);
    expect(body.syncMode).toBe('delta');
  });

  it('leaves every other entity, and a systems delta, alone', () => {
    const principals = { syncMode: 'full' };
    expect(coerceSystemsSyncMode('principals', principals)).toBe(false);
    expect(principals.syncMode).toBe('full');
    const systemsDelta = { syncMode: 'delta' };
    expect(coerceSystemsSyncMode('systems', systemsDelta)).toBe(false);
    expect(systemsDelta.syncMode).toBe('delta');
  });
});

describe('deleteOwnershipClause (H-04)', () => {
  it('adds nothing for an unrestricted key', () => {
    expect(deleteOwnershipClause('Principals', null, [UUID])).toEqual({ clause: '', params: [[UUID]] });
  });

  it('limits the delete to rows the caller\'s systems own, bound as $2', () => {
    expect(deleteOwnershipClause('Principals', [7], [UUID])).toEqual({
      clause: ' AND COALESCE((t."systemId" = ANY($2::int[])), false)',
      params: [[UUID], [7]],
    });
  });

  it('uses the derived owner for a table without a systemId column', () => {
    expect(deleteOwnershipClause('Contexts', [7], [UUID]).clause).toContain('t."scopeSystemId" = ANY($2::int[])');
  });
});

describe('applyDeleteByIds — restricted key (H-04)', () => {
  it('passes the allow-list and the ownership clause to the soft delete', async () => {
    db.query.mockResolvedValue({ rowCount: 1 });
    const result = { deleted: 0 };
    await applyDeleteByIds({ deletedIds: [UUID] }, 'Principals', result, [7]);
    const [sql, params] = db.query.mock.calls.at(-1);
    expect(sql).toMatch(/UPDATE "Principals" t SET "deletedAt" = now\(\) WHERE t.id = ANY\(\$1::uuid\[\]\) AND t."deletedAt" IS NULL AND COALESCE/);
    expect(params).toEqual([[UUID], [7]]);
    expect(result.deleted).toBe(1);
  });

  it('passes it to the hard delete too', async () => {
    db.query.mockResolvedValue({ rowCount: 0 });
    await applyDeleteByIds({ deletedIds: [UUID] }, 'Contexts', { deleted: 0 }, [7]);
    const [sql, params] = db.query.mock.calls.at(-1);
    expect(sql).toMatch(/^DELETE FROM "Contexts" t WHERE t.id = ANY\(\$1::uuid\[\]\) AND COALESCE/);
    expect(params).toEqual([[UUID], [7]]);
  });
});
