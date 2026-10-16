import { describe, it, expect } from 'vitest';
import { createParams } from '../db/sqlParams.js';
import {
  enrichmentConditionClause, parseEnrichmentField, isEnrichmentField, enrichmentField,
  MAX_SOURCE_LENGTH, MAX_ATTRIBUTE_LENGTH, MAX_VALUES,
} from './enrichmentCondition.js';
import { buildEntitySubquery } from './filterSql.js';
import { buildScopeAsofSql } from './scopeHistory.js';

const build = (entity, field, values) => {
  const { params, bind } = createParams();
  return { ...enrichmentConditionClause({ entity, idExpr: 'id', field, values, bind }), params };
};

describe('parseEnrichmentField', () => {
  it('splits source and attribute at the first dot after org.', () => {
    expect(parseEnrichmentField('org.Maten.expertises')).toEqual({ source: 'Maten', attribute: 'expertises' });
    expect(parseEnrichmentField('org.Maten.e.mail')).toEqual({ source: 'Maten', attribute: 'e.mail' });
    expect(enrichmentField('Maten', 'e.mail')).toBe('org.Maten.e.mail');
  });

  it('null for a non-org field, an empty source or attribute, or an over-long part', () => {
    for (const f of ['ext.x', 'Maten.x', 'org.', 'org.Maten', 'org..x', 'org.Maten.', null, 42]) {
      expect(parseEnrichmentField(f), String(f)).toBeNull();
    }
    expect(parseEnrichmentField(`org.${'s'.repeat(MAX_SOURCE_LENGTH)}.a`)).not.toBeNull();
    expect(parseEnrichmentField(`org.${'s'.repeat(MAX_SOURCE_LENGTH + 1)}.a`)).toBeNull();
    expect(parseEnrichmentField(`org.S.${'a'.repeat(MAX_ATTRIBUTE_LENGTH)}`)).not.toBeNull();
    expect(parseEnrichmentField(`org.S.${'a'.repeat(MAX_ATTRIBUTE_LENGTH + 1)}`)).toBeNull();
  });

  it('only org.* is an enrichment field', () => {
    expect(isEnrichmentField('org.Maten.x')).toBe(true);
    expect(isEnrichmentField('organisation')).toBe(false);
    expect(isEnrichmentField(undefined)).toBe(false);
  });
});

describe('enrichmentConditionClause', () => {
  it('binds source, attribute and the cleaned values; ANY value of a list matches', () => {
    const out = build('Resource', 'org.Maten.expertises', ['IAM', 'IAM', '', null, 7]);
    expect(out.params).toEqual(['Maten', 'expertises', ['IAM', '7']]);
    expect(out.clause).toMatch(/^id IN \(\s+WITH enr_t AS \(/);
    expect(out.clause).toMatch(/AND e\."entityType" = \$1/);
    expect(out.clause).toMatch(/EXISTS \(SELECT 1 FROM jsonb_array_elements_text\(CASE jsonb_typeof\(e\."attributes"->\(\$2::text\)\)[\s\S]*AS ev\(v\) WHERE ev\.v = ANY\(\$3::text\[\]\)\)/);
    expect(out.clause).toMatch(/SELECT tid FROM enr_t WHERE tt = 'Resource'\)$/);
  });

  it('a principal matches rows about itself or its identity; an identity rows about itself or its accounts', () => {
    const p = build('Principal', 'org.Maten.level', ['Senior']).clause;
    expect(p).toMatch(/SELECT tid FROM enr_t WHERE tt = 'Principal'\n\s+UNION\n\s+SELECT im\."principalId" FROM "IdentityMembers" im JOIN enr_t x ON x\.tt = 'Identity' AND x\.tid = im\."identityId"/);
    const i = build('Identity', 'org.Maten.level', ['Senior']).clause;
    expect(i).toMatch(/SELECT tid FROM enr_t WHERE tt = 'Identity'\n\s+UNION\n\s+SELECT im\."identityId" FROM "IdentityMembers" im JOIN enr_t x ON x\.tt = 'Principal' AND x\.tid = im\."principalId"/);
    expect(build('Resource', 'org.Maten.level', ['Senior']).clause).not.toMatch(/IdentityMembers/);
  });

  it('caps the values', () => {
    const many = Array.from({ length: MAX_VALUES + 5 }, (_, i) => `v${i}`);
    expect(build('Principal', 'org.M.a', many).params[2]).toHaveLength(MAX_VALUES);
  });

  it('drops a malformed condition before binding anything', () => {
    for (const [entity, field, values] of [
      ['Context', 'org.M.a', ['x']],
      ['Principal', 'org.M', ['x']],
      ['Principal', 'org.M.a', []],
      ['Principal', 'org.M.a', ['', null]],
      ['Principal', 'org.M.a', 'x'],
    ]) {
      const out = build(entity, field, values);
      expect(out.warning, `${entity} ${field}`).toBeTruthy();
      expect(out.clause).toBeUndefined();
      expect(out.params).toEqual([]);
    }
  });
});

describe('through the matrix filter', () => {
  const cond = (values) => ({ kind: 'attribute', field: 'org.Maten.expertises', values });

  it('filterSql: include AND exclude → "A but not C", the exclusion NULL-safe', () => {
    const { params, bind } = createParams();
    const { sql, warnings } = buildEntitySubquery({
      entity: 'Principal', include: [cond(['IAM'])], exclude: [cond(['SAP'])], validColumns: new Set(), contextTypes: new Map(), bind,
    });
    expect(warnings).toEqual([]);
    expect(sql).toMatch(/^\(SELECT id FROM "Principals" WHERE id IN \(/);
    expect(sql).toMatch(/AND \(id IN \([\s\S]*\)\) IS NOT TRUE\)$/);
    expect(params).toEqual(['Maten', 'expertises', ['IAM'], 'Maten', 'expertises', ['SAP']]);
  });

  it('filterSql: a malformed enrichment field is dropped with a warning, not treated as a column', () => {
    const { bind } = createParams();
    const out = buildEntitySubquery({ entity: 'Principal', include: [cond([])], validColumns: new Set(['org']), contextTypes: new Map(), bind });
    expect(out).toEqual({ sql: null, warnings: ['attribute condition for org.Maten.expertises dropped'] });
  });

  it('scopeHistory: the same builder against the as-of row id, flagged as current data', () => {
    const { params, bind } = createParams();
    const out = buildScopeAsofSql({
      filter: { rowType: 'principal', subject: { include: [cond(['IAM'])] }, resource: {} },
      principalColSet: new Set(), resourceColSet: new Set(), contextTypes: new Map(), bind,
    });
    expect(out.sql).toContain(`(sp.state->>'id')::uuid IN (`);
    expect(out.scopeMode).toBe('context-current');
    expect(out.warnings).toEqual([]);
    expect(params).toEqual(['Maten', 'expertises', ['IAM']]);
  });

  it('scopeHistory: a dropped enrichment condition warns and does not flag current data', () => {
    const { bind } = createParams();
    const out = buildScopeAsofSql({
      filter: { rowType: 'principal', subject: { include: [cond([])] }, resource: {} },
      principalColSet: new Set(), resourceColSet: new Set(), contextTypes: new Map(), bind,
    });
    expect(out.warnings).toEqual(['history: attribute condition for org.Maten.expertises dropped']);
    expect(out.scopeMode).toBe('attribute');
  });
});
