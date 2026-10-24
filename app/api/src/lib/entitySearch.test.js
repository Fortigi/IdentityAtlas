import { describe, it, expect } from 'vitest';
import { createParams } from '../db/sqlParams.js';
import {
  SEARCH_ENTITIES, MIN_EXTENDED_LENGTH, parseExtendedSearch, phoneNeedle,
  searchExpression, buildSearchWhere, matchedFields, withMatchedOn,
} from './entitySearch.js';

describe('parseExtendedSearch', () => {
  it.each([
    ['true', true], ['TRUE', true], ['1', true],
    ['false', false], ['0', false], ['yes', false], ['', false], [undefined, false],
  ])('extendedSearch=%s → %s', (value, expected) => {
    expect(parseExtendedSearch({ extendedSearch: value })).toBe(expected);
  });

  it('treats a missing query object as off', () => {
    expect(parseExtendedSearch(undefined)).toBe(false);
  });
});

describe('phoneNeedle', () => {
  // Every way of writing one Dutch mobile number lands on the same nine digits,
  // which are inside the digits-only form of every other way of writing it.
  it.each([
    '+31 6 1234 5678', '0031612345678', '06-12345678', '0612345678', '(06) 1234.5678',
  ])('%s → 612345678', (term) => {
    expect(phoneNeedle(term)).toBe('612345678');
  });

  it('strips only ONE prefix: 00 or 0, not every leading zero', () => {
    // An employee number with leading zeros keeps them after the first.
    expect(phoneNeedle('000-123-456')).toBe('0123456');
  });

  it('keeps the last nine digits of a longer national number', () => {
    expect(phoneNeedle('+1 (415) 555-0100')).toBe('155550100');
  });

  it('is null below eight digits — too short to be a phone number', () => {
    expect(phoneNeedle('123-4567')).toBeNull();
  });

  it('is null for anything with letters', () => {
    expect(phoneNeedle('E-12345678')).toBeNull();
    expect(phoneNeedle('CI0012345678')).toBeNull();
  });

  it('is null when the needle is the term itself (nothing to add)', () => {
    expect(phoneNeedle('612345678')).toBeNull();
  });

  it('is null for empty input', () => {
    expect(phoneNeedle('')).toBeNull();
    expect(phoneNeedle(null)).toBeNull();
  });
});

describe('searchExpression', () => {
  it('lists every column of the entity on the alias, id cast to text, then the JSON document', () => {
    expect(searchExpression('context', 'c')).toBe(
      'public.ia_search_text(ARRAY[c."id"::text, c."displayName", c."description", c."externalId", c."contextType"], c."extendedAttributes")',
    );
  });

  it('throws on an unknown entity instead of building a query the index cannot serve', () => {
    expect(() => searchExpression('system', 's')).toThrow(/unknown search entity/);
  });
});

describe('buildSearchWhere', () => {
  it('adds nothing without a term (and binds nothing)', () => {
    const { params, bind } = createParams();
    expect(buildSearchWhere('principal', 'u', '   ', { extended: true }, bind)).toBe('');
    expect(params).toEqual([]);
  });

  it('normal mode: an ILIKE per identifying column, one bound value', () => {
    const { params, bind } = createParams();
    const sql = buildSearchWhere('principal', 'u', 'E-77', {}, bind);
    expect(sql).toBe(
      ` AND (u."displayName" ILIKE $1 ESCAPE '\\' OR u."email" ILIKE $1 ESCAPE '\\'`
      + ` OR u."employeeId" ILIKE $1 ESCAPE '\\' OR u."externalId" ILIKE $1 ESCAPE '\\')`,
    );
    expect(params).toEqual(['%E-77%']);
  });

  it('normal mode does not touch extendedAttributes', () => {
    const { bind } = createParams();
    expect(buildSearchWhere('resource', 'r', 'CI001', {}, bind)).not.toContain('extendedAttributes');
  });

  it('escapes LIKE wildcards in the term', () => {
    const { params, bind } = createParams();
    buildSearchWhere('context', 'c', '50%_off', { extended: true }, bind);
    expect(params).toEqual(['%50\\%\\_off%']);
  });

  it('extended mode matches the index expression', () => {
    const { params, bind } = createParams();
    const sql = buildSearchWhere('context', 'c', 'CI0012345', { extended: true }, bind);
    expect(sql).toBe(` AND (${searchExpression('context', 'c')} ILIKE $1 ESCAPE '\\')`);
    expect(params).toEqual(['%CI0012345%']);
  });

  it('extended mode adds the digits needle for a phone-like term', () => {
    const { params, bind } = createParams();
    const sql = buildSearchWhere('principal', 'u', '06-12345678', { extended: true }, bind);
    const expr = searchExpression('principal', 'u');
    expect(sql).toBe(` AND (${expr} ILIKE $1 ESCAPE '\\' OR ${expr} ILIKE $2 ESCAPE '\\')`);
    expect(params).toEqual(['%06-12345678%', '%612345678%']);
  });

  it(`falls back to normal mode below ${MIN_EXTENDED_LENGTH} characters (the trigram index cannot serve it)`, () => {
    const { bind } = createParams();
    const sql = buildSearchWhere('principal', 'u', 'NL', { extended: true }, bind);
    expect(sql).not.toContain('ia_search_text');
    expect(sql).toContain('u."displayName" ILIKE $1');
  });

  it('linkedPrincipals also matches an identity through its accounts, with the principal expression', () => {
    const { params, bind } = createParams();
    const sql = buildSearchWhere('identity', 'i', 'CI0012345', { extended: true, linkedPrincipals: true }, bind);
    expect(sql).toContain(`${searchExpression('identity', 'i')} ILIKE $1`);
    expect(sql).toContain('_sim."identityId" = i.id');
    expect(sql).toContain(`${searchExpression('principal', '_sp')} ILIKE $1`);
    expect(params).toEqual(['%CI0012345%']);
  });

  it('linkedPrincipals is ignored in normal mode', () => {
    const { bind } = createParams();
    expect(buildSearchWhere('identity', 'i', 'Jan', { linkedPrincipals: true }, bind)).not.toContain('IdentityMembers');
  });
});

describe('matchedFields', () => {
  const row = {
    id: 'a1b2', displayName: 'Jan Jansen', userPrincipalName: 'jan@contoso.com', employeeId: '00077',
    extendedAttributes: {
      mobilePhone: '+31 6 1234 5678',
      businessPhones: ['020-555 1234'],
      employeeOrgData: { costCenter: 'KST-4711', division: 'Finance' },
      accountEnabled: true,
      floor: 4,
    },
  };

  it('names a nested JSON value by its dotted path', () => {
    expect(matchedFields('principal', row, 'kst-4711')).toEqual(['employeeOrgData.costCenter']);
  });

  it('names a list by its key, not by an index', () => {
    expect(matchedFields('principal', row, '555 1234')).toEqual(['businessPhones']);
  });

  it('matches a phone number written differently through its digits', () => {
    expect(matchedFields('principal', row, '06-12345678')).toEqual(['mobilePhone']);
  });

  it('reports every matching field, columns first', () => {
    expect(matchedFields('principal', row, 'jan')).toEqual(['displayName']);
    expect(matchedFields('principal', row, 'jan', { email: 'userPrincipalName' })).toEqual(['displayName', 'email']);
  });

  it('matches numbers but never booleans', () => {
    expect(matchedFields('principal', row, '4')).toContain('floor');
    expect(matchedFields('principal', row, 'true')).toEqual([]);
  });

  it('parses a document stored as a JSON string and names a bare string document', () => {
    expect(matchedFields('context', { extendedAttributes: '{"CMDB Reference":"CI001"}' }, 'ci001')).toEqual(['CMDB Reference']);
    expect(matchedFields('context', { extendedAttributes: '"CI001"' }, 'ci001')).toEqual(['extendedAttributes']);
    expect(matchedFields('context', { extendedAttributes: '{not json' }, 'ci001')).toEqual([]);
  });

  it('returns [] without a term or a row', () => {
    expect(matchedFields('principal', row, '')).toEqual([]);
    expect(matchedFields('principal', null, 'jan')).toEqual([]);
  });
});

describe('withMatchedOn', () => {
  const rows = [{ displayName: 'Payroll', extendedAttributes: { cmdb: 'CI001' } }, { displayName: 'Other' }];

  it('leaves rows untouched outside an extended search', () => {
    expect(withMatchedOn('context', rows, 'CI001', { extended: false })).toBe(rows);
    expect(withMatchedOn('context', rows, 'CI', { extended: true })).toBe(rows); // below the minimum
  });

  it('stamps matchedOn on every row of an extended search', () => {
    const out = withMatchedOn('context', rows, 'CI001', { extended: true });
    expect(out.map(r => r.matchedOn)).toEqual([['cmdb'], []]);
  });

  it('uses the fallback for a row none of whose own fields matched', () => {
    const out = withMatchedOn('identity', rows, 'CI001', { extended: true, fallback: 'linkedAccount' });
    expect(out.map(r => r.matchedOn)).toEqual([['cmdb'], ['linkedAccount']]);
  });
});

describe('SEARCH_ENTITIES', () => {
  it('every identifying column is also searched in extended mode', () => {
    for (const [entity, spec] of Object.entries(SEARCH_ENTITIES)) {
      for (const col of spec.identifying) expect(spec.all, `${entity}.${col}`).toContain(col);
    }
  });
});
