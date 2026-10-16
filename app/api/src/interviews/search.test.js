import { describe, it, expect, vi } from 'vitest';
import { MAX_CANDIDATES, SEARCH_KINDS, labelOf, searchEntities, searchSql } from './search.js';

const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: `id${i}`, displayName: `Peter ${i}`, l1: 'Consultant', l2: 'Finance', l3: null, score: '1.00', inScope: false }));

describe('searchSql', () => {
  it('covers exactly the four entity kinds a mention can be', () => {
    expect(SEARCH_KINDS).toEqual(['identity', 'account', 'resource', 'context']);
  });

  it('carries user input only as parameters and escapes the LIKE pattern', () => {
    for (const kind of SEARCH_KINDS) {
      const sql = searchSql(kind);
      expect(sql).toContain(`ILIKE $2 ESCAPE '\\'`);
      expect(sql).toContain('$3::uuid');
      // One more than the cap, so a cut can be reported (decision-principles B2).
      expect(sql).toMatch(new RegExp(`LIMIT ${MAX_CANDIDATES + 1}\\s*$`));
    }
  });

  it('ranks in-scope candidates first, then by score', () => {
    expect(searchSql('identity')).toMatch(/ORDER BY "inScope" DESC, "score" DESC/);
  });

  it('never selects contact details', () => {
    for (const kind of SEARCH_KINDS) expect(searchSql(kind)).not.toMatch(/"email"|"mail"|"employeeId"/);
  });

  it('excludes soft-deleted accounts and resources (the report catalog filters)', () => {
    expect(searchSql('account')).toMatch(/n0\."deletedAt" IS NULL/);
    expect(searchSql('resource')).toMatch(/n0\."deletedAt" IS NULL/);
    expect(searchSql('identity')).toContain('FROM "Identities" n0');
    expect(searchSql('context')).toContain('FROM "Contexts" n0');
  });

  it('counts a person in scope through any of their accounts', () => {
    expect(searchSql('identity')).toMatch(/"IdentityMembers" im WHERE im\."identityId" = n0\."id"/);
  });
});

describe('labelOf', () => {
  it('joins the non-empty parts in order', () => {
    expect(labelOf({ l1: 'Consultant', l2: '', l3: 'Entra ID' })).toBe('Consultant · Entra ID');
    expect(labelOf({ l1: null, l2: '  ', l3: null })).toBe('');
  });
});

describe('searchEntities', () => {
  it('binds the words, the escaped contains-pattern and the scope', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await searchEntities(query, { kind: 'identity', text: '50%_peter', scopeContextId: 'c1' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual(['50%_peter', '%50\\%\\_peter%', 'c1']);
  });

  it('returns at most five candidates and says when there were more', async () => {
    const six = await searchEntities(vi.fn(async () => ({ rows: rows(6) })), { kind: 'identity', text: 'Peter' });
    expect(six.candidates.map(c => c.id)).toEqual(['id0', 'id1', 'id2', 'id3', 'id4']);
    expect(six.truncated).toBe(true);
    const five = await searchEntities(vi.fn(async () => ({ rows: rows(5) })), { kind: 'identity', text: 'Peter' });
    expect(five.truncated).toBe(false);
  });

  it('shapes a candidate: numeric score, strict boolean scope, label, kind — nothing else', async () => {
    const query = vi.fn(async () => ({ rows: [{ id: 'p1', displayName: 'Peter Jansen', l1: 'DBA', l2: 'ICT', l3: null, score: '0.64', inScope: 't', extra: 'x' }] }));
    const { candidates } = await searchEntities(query, { kind: 'identity', text: 'Peter' });
    expect(candidates).toEqual([{ id: 'p1', kind: 'identity', displayName: 'Peter Jansen', label: 'DBA · ICT', score: 0.64, inScope: false }]);
  });
});
