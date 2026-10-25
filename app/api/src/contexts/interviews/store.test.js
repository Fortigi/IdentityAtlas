// The SQL module's own decisions (what it sends, not whether the SQL is right —
// that is contract-tests/contextInterviews.contract.test.js).
import { describe, it, expect, vi } from 'vitest';
import * as store from './store.js';

const db = (rows = []) => ({ query: vi.fn(async () => ({ rows, rowCount: rows.length })), queryOne: vi.fn(async () => rows[0] ?? null) });

describe('insertInterview', () => {
  it('stores the survey an interview was made from, and none for an uploaded transcript', async () => {
    const d = db([{ id: 'iv' }]);
    const row = { contextId: 'ctx', intervieweeName: 'Anna', interviewedAt: '2026-10-23', fileName: 'f', transcript: 't', extractionStatus: 'done' };
    await store.insertInterview(d, { ...row, surveyRequestId: 'req-1' });
    await store.insertInterview(d, row);
    expect(d.query.mock.calls[0][0]).toMatch(/"createdBy", "surveyRequestId"\)\s+VALUES \(\$1, \$2, \$3, \$4, \$5::date, \$6, \$7, \$8, \$9, \$10, \$11\)/);
    expect(d.query.mock.calls[0][1][10]).toBe('req-1');
    expect(d.query.mock.calls[1][1][10]).toBeNull();
  });
});

describe('insertClaims', () => {
  it('sends one statement with every column of every claim, nulls filled in, and returns the ids', async () => {
    const d = db([{ id: 'c1' }, { id: 'c2' }]);
    const ids = await store.insertClaims(d, { interviewId: 'iv', contextId: 'ctx', proposedBy: 'model' }, [
      { claimKind: 'description', subjectKind: 'Context', value: 'A tool', quote: 'a tool', confidence: 0.7 },
      { claimKind: 'role', subjectKind: 'Person', subjectName: 'Piet', principalId: 'p', attribute: 'dayToDay', value: 'v', roleSuggestion: 'Responsible', extra: 'ignored' },
    ]);
    expect(ids).toEqual(['c1', 'c2']);
    const [sql, params] = d.query.mock.calls[0];
    expect(sql).toMatch(/jsonb_to_recordset\(\$4::jsonb\)/);
    expect(params.slice(0, 3)).toEqual(['iv', 'ctx', 'model']);
    const records = JSON.parse(params[3]);
    expect(Object.keys(records[0])).toEqual(['claimKind', 'subjectKind', 'principalId', 'identityId', 'subjectName', 'subjectMatch', 'attribute',
      'value', 'periodFrom', 'periodTo', 'periodText', 'quote', 'confidence', 'roleSuggestion', 'relevance', 'quoteStart', 'quoteEnd',
      'resourceId', 'surveyQuestionId']);
    expect(records[0].principalId).toBeNull();
    expect(records[0].surveyQuestionId).toBeNull();
    expect(records[1]).toMatchObject({ subjectName: 'Piet', principalId: 'p', roleSuggestion: 'Responsible' });
    expect(records[1].extra).toBeUndefined();
  });

  it('sends nothing for no claims', async () => {
    const d = db();
    expect(await store.insertClaims(d, { interviewId: 'iv', contextId: 'ctx', proposedBy: 'model' }, [])).toEqual([]);
    expect(d.query).not.toHaveBeenCalled();
  });
});

describe('getInterview', () => {
  it('reads the transcript only when asked, and only for the named context', async () => {
    const d = db([{ id: 'iv' }]);
    await store.getInterview(d, 'ctx', 'iv');
    await store.getInterview(d, 'ctx', 'iv', { withTranscript: true });
    expect(d.queryOne.mock.calls[0][0]).not.toMatch(/iv\.transcript/);
    expect(d.queryOne.mock.calls[1][0]).toMatch(/iv\.transcript/);
    expect(d.queryOne.mock.calls[1][1]).toEqual(['iv', 'ctx']);
  });
});

describe('mentionsOf', () => {
  it('refuses a column that is not a holder column — it is interpolated', async () => {
    await expect(store.mentionsOf(db(), 'id; DROP TABLE x', 'p', ['confirmed'])).rejects.toThrow(/unknown holder column/);
  });

  it('filters on the holder and the statuses given', async () => {
    const d = db([{ contextId: 'ctx' }]);
    expect(await store.mentionsOf(d, 'identityId', 'i-1', ['confirmed', 'edited'])).toEqual([{ contextId: 'ctx' }]);
    expect(d.query.mock.calls[0][0]).toMatch(/c\."identityId" = \$1 AND c\."claimStatus" = ANY\(\$2::text\[\]\)/);
    expect(d.query.mock.calls[0][1]).toEqual(['i-1', ['confirmed', 'edited']]);
  });
});

describe('currentAccountable / setExtraction / deleteInterview', () => {
  it('answer null, pass the run flags and the row count', async () => {
    expect(await store.currentAccountable(db(), 'ctx')).toBeNull();
    const d = db();
    await store.setExtraction(d, 'iv', { status: 'running', started: true });
    expect(d.query.mock.calls[0][1]).toEqual(['iv', 'running', null, null, true]);
    const del = { query: vi.fn(async () => ({ rowCount: 0 })) };
    expect(await store.deleteInterview(del, 'ctx', 'iv')).toBe(0);
    expect(del.query.mock.calls[0][1]).toEqual(['iv', 'ctx']);
  });
});

describe('rejectProposed / interviewQuotes', () => {
  it('rejects only proposed claims of the context, by kind and/or tier (no tier counts as high), as the user', async () => {
    const d = db([{ id: 'c1' }, { id: 'c2' }]);
    expect(await store.rejectProposed(d, 'ctx', { relevance: 'low' }, 'u@example.test')).toEqual(['c1', 'c2']);
    const [sql, params] = d.query.mock.calls[0];
    expect(params).toEqual(['ctx', null, 'low', 'u@example.test']);
    expect(sql).toMatch(/"claimStatus" = 'proposed'/);
    expect(sql).toMatch(/COALESCE\(relevance, 'high'\) = \$3/);
    await store.rejectProposed(d, 'ctx', { kind: 'description' }, 'u');
    expect(d.query.mock.calls[1][1]).toEqual(['ctx', 'description', null, 'u']);
  });

  it('reads the quotes of one interview with their stored offsets', async () => {
    const d = db([{ id: 'c1', quote: 'q', quoteStart: 1, quoteEnd: 2 }]);
    expect(await store.interviewQuotes(d, 'iv')).toEqual([{ id: 'c1', quote: 'q', quoteStart: 1, quoteEnd: 2 }]);
    expect(d.query.mock.calls[0][1]).toEqual(['iv']);
    expect(d.query.mock.calls[0][0]).toMatch(/quote IS NOT NULL/);
  });
});
