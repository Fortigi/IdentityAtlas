// The SQL module's own decisions (what it sends, not whether the SQL is right —
// that is contract-tests/contextInterviews.contract.test.js).
import { describe, it, expect, vi } from 'vitest';
import * as store from './store.js';

const db = (rows = []) => ({ query: vi.fn(async () => ({ rows, rowCount: rows.length })), queryOne: vi.fn(async () => rows[0] ?? null) });

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
      'value', 'periodFrom', 'periodTo', 'periodText', 'quote', 'confidence', 'roleSuggestion', 'relevance', 'quoteStart', 'quoteEnd']);
    expect(records[0].principalId).toBeNull();
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

describe('source kinds', () => {
  it('pasted text by its stored name, a source from nobody as a file, else an interview — on interviews and claims alike', () => {
    expect(store.SOURCE_KIND_SQL).toMatch(new RegExp(`WHEN iv\\."fileName" = '${store.PASTED_TEXT_NAME}' THEN 'text'`));
    expect(store.SOURCE_KIND_SQL).toMatch(/WHEN iv\."principalId" IS NULL AND iv\."identityId" IS NULL THEN 'file' ELSE 'interview'/);
    expect(store.SOURCE_KIND_SQL.indexOf("'text'")).toBeLessThan(store.SOURCE_KIND_SQL.indexOf("'file'"));
  });
});

describe('the People overview reads', () => {
  it('a claim is mapped to the holder of the context kind: an account through the unit it lists, a person through any account', () => {
    expect(store.personClaimsSql('Principal')).toMatch(/COALESCE\(c\."principalId", \(SELECT im\."principalId" FROM "IdentityMembers" im\s+JOIN "ContextMembers" cm ON cm\."contextId" = c\."contextId" AND cm\."memberId" = im\."principalId"/);
    expect(store.personClaimsSql('Identity')).toMatch(/COALESCE\(c\."identityId", \(SELECT im\."identityId" FROM "IdentityMembers" im\s+WHERE im\."principalId" = c\."principalId"/);
    expect(store.personClaimsSql('Resource')).toMatch(/NULL::uuid AS "holderId"/);
  });

  it('reads the claims with the person kinds and the statuses given', async () => {
    const d = db([{ id: 'c1' }]);
    expect(await store.personClaims(d, 'ctx', 'Principal', ['confirmed'])).toEqual([{ id: 'c1' }]);
    expect(d.query.mock.calls[0]).toEqual([store.personClaimsSql('Principal'), ['ctx', store.PERSON_CLAIM_KINDS, ['confirmed']]]);
  });

  it('reads the holders the claims name and everyone marked former, with whether the context lists them; nothing for other members', async () => {
    expect(store.holderRowsSql('Principal')).toMatch(/FROM "Principals" m/);
    expect(store.holderRowsSql('Identity')).toMatch(/FROM "Identities" m/);
    expect(store.holderRowsSql('Principal')).toMatch(/OR m\.id IN \(SELECT x\."memberId" FROM "ContextMemberOverrides" x WHERE x\."contextId" = \$1\)/);
    const d = db([{ id: 'p' }]);
    expect(await store.holderRows(d, 'ctx', 'Identity', ['i'])).toEqual([{ id: 'p' }]);
    expect(d.query.mock.calls[0][1]).toEqual(['ctx', ['i']]);
    const none = db();
    expect(await store.holderRows(none, 'ctx', 'Resource', ['r'])).toEqual([]);
    expect(none.query).not.toHaveBeenCalled();
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
