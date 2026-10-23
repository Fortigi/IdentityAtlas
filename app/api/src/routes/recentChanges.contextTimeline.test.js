// The context timeline: the context row's own changes without bookkeeping
// churn, merged with what its interviews did — uploads, extraction, claim
// decisions, roles set from a claim — and a reader sees confirmed decisions only.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

vi.mock('../db/connection.js');
vi.mock('./contexts/interviews.js', () => ({ canWriteContexts: vi.fn(() => true) }));
import { query } from '../db/connection.js';
import { canWriteContexts } from './contexts/interviews.js';
import { TIMELINE_INTERVIEWS_SQL, TIMELINE_DECISIONS_SQL } from '../contexts/interviews/store.js';

const { default: router } = await import('./recentChanges.js');
const { CONTEXT_NOISE_FIELDS } = await import('./recentChanges/timeline.js');
const app = mountRouter(router);

const CTX = '11111111-1111-4111-8111-111111111111';
const PIET = '22222222-2222-4222-8222-222222222222';

const historyRow = {
  tableName: 'Contexts', operation: 'U', changedAt: '2026-10-02T09:00:00Z',
  prevData: { displayName: 'Harbour Office', description: null }, rowData: { displayName: 'Harbour Office', description: 'Runs the quays.' },
};
const interviewRow = { id: 'iv-1', intervieweeName: 'Anna Voorbeeld', interviewedAt: '2026-10-01', fileName: 'gesprek.txt', createdAt: '2026-10-01T08:00:00Z', extracted: 14, extractedAt: '2026-10-01T08:05:00Z' };
const roleDecision = {
  id: 'c-1', claimKind: 'role', attribute: 'dayToDay', value: 'does the day-to-day', status: 'confirmed', decidedAt: '2026-10-03T10:00:00Z',
  subjectDisplayName: 'Piet Proef', intervieweeName: 'Anna Voorbeeld', interviewedAt: '2026-10-01',
  appliedRole: 'Responsible', roleHolderName: 'Piet Proef', roleHolderId: PIET, roleHolderIsAccount: true,
};
const rejected = { id: 'c-2', claimKind: 'membership', attribute: 'former', value: 'former', status: 'rejected', decidedAt: '2026-10-03T11:00:00Z', subjectName: 'Karel', intervieweeName: 'Anna Voorbeeld', interviewedAt: '2026-10-01' };

beforeEach(() => {
  query.mockReset();
  canWriteContexts.mockReturnValue(true);
  query.mockImplementation(async (sql, params) => {
    if (sql === TIMELINE_INTERVIEWS_SQL) return { rows: [interviewRow] };
    if (sql === TIMELINE_DECISIONS_SQL) return { rows: params[2].includes('rejected') ? [rejected, roleDecision] : [roleDecision] };
    if (sql.includes('FROM "_history"')) return { rows: [historyRow] };
    return { rows: [] };
  });
});

describe('GET /api/contexts/:id/timeline', () => {
  it('skips updates that only moved bookkeeping, in SQL, before the LIMIT', async () => {
    await request(app).get(`/api/contexts/${CTX}/timeline`);
    const sql = query.mock.calls.map(c => c[0]).find(s => s.includes('FROM "_history"'));
    expect(sql).toContain(`NOT (operation = 'U' AND ("rowData" - ARRAY[${CONTEXT_NOISE_FIELDS.map(f => `'${f}'`).join(', ')}]::text[]) IS NOT DISTINCT FROM ("prevData" - ARRAY[`);
    expect(CONTEXT_NOISE_FIELDS).toContain('lastCalculatedAt');
  });

  it('an analyst sees the upload, the extraction, the role set and the rejection beside the attribute change, newest first', async () => {
    const res = await request(app).get(`/api/contexts/${CTX}/timeline?sinceDays=30`);
    expect(res.status).toBe(200);
    expect(res.body.events.map(e => e.summary)).toEqual([
      'Rejected: Membership — Karel (former member) — from the interview with Anna Voorbeeld, 2026-10-01',
      'Piet Proef set as Responsible — from the interview with Anna Voorbeeld, 2026-10-01',
      'Description: — → Runs the quays.',
      '14 claims extracted from the interview with Anna Voorbeeld',
      'Interview with Anna Voorbeeld uploaded (gesprek.txt)',
    ]);
    expect(res.body.events[1]).toMatchObject({ eventKind: 'interview', counterpartyKind: 'user', counterpartyId: PIET });
    const decisions = query.mock.calls.find(c => c[0] === TIMELINE_DECISIONS_SQL);
    expect(decisions[1]).toEqual([CTX, 30, ['confirmed', 'edited', 'rejected'], 50]);
  });

  it('a reader sees confirmed decisions only: no upload, no extraction, nothing rejected', async () => {
    canWriteContexts.mockReturnValue(false);
    const res = await request(app).get(`/api/contexts/${CTX}/timeline`);
    expect(res.body.events.map(e => e.summary)).toEqual([
      'Piet Proef set as Responsible — from the interview with Anna Voorbeeld, 2026-10-01',
      'Description: — → Runs the quays.',
    ]);
    expect(query.mock.calls.some(c => c[0] === TIMELINE_INTERVIEWS_SQL)).toBe(false);
    expect(query.mock.calls.find(c => c[0] === TIMELINE_DECISIONS_SQL)[1][2]).toEqual(['confirmed', 'edited']);
  });

  it('a failing interview read leaves the rest of the timeline', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockImplementation(async (sql) => {
      if (sql === TIMELINE_DECISIONS_SQL) throw new Error('boom');
      if (sql.includes('FROM "_history"')) return { rows: [historyRow] };
      return { rows: [] };
    });
    const res = await request(app).get(`/api/contexts/${CTX}/timeline`);
    expect(res.status).toBe(200);
    expect(res.body.events.map(e => e.summary)).toEqual(['Description: — → Runs the quays.']);
    spy.mockRestore();
  });

  it('other entities read no interview tables', async () => {
    await request(app).get(`/api/user/${PIET}/timeline`);
    expect(query.mock.calls.some(c => c[0] === TIMELINE_DECISIONS_SQL || c[0] === TIMELINE_INTERVIEWS_SQL)).toBe(false);
  });
});
