import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db/connection.js');
import { query } from '../db/connection.js';
import { listEnrichmentFields, enrichmentFieldValues, shapeFields, VALUES_PER_FIELD } from './enrichmentFields.js';

const r = (source, key, value, multi = false, distinctCount = 2) => ({ source, key, value, multi, distinctCount });

beforeEach(() => query.mockReset());

describe('shapeFields', () => {
  it('one picker field per source and attribute, labelled "<attr> (<source>)", multi when any value came from a list', () => {
    expect(shapeFields([
      r('Maten', 'expertises', 'Azure', false), r('Maten', 'expertises', 'IAM', true),
      r('Maten', 'level', 'Senior', false, 1),
    ])).toEqual([
      { column: 'org.Maten.expertises', key: 'org.Maten.expertises', type: 'text', values: ['Azure', 'IAM'], truncated: false, label: 'expertises (Maten)', multi: true },
      { column: 'org.Maten.level', key: 'org.Maten.level', type: 'text', values: ['Senior'], truncated: false, label: 'level (Maten)', multi: false },
    ]);
  });

  it('truncated only past the page size', () => {
    expect(shapeFields([r('M', 'a', 'x', false, VALUES_PER_FIELD)])[0].truncated).toBe(false);
    expect(shapeFields([r('M', 'a', 'x', false, VALUES_PER_FIELD + 1)])[0].truncated).toBe(true);
  });
});

describe('listEnrichmentFields', () => {
  it('reads Principal and Identity enrichments for the principal picker, split values, capped per field', async () => {
    query.mockResolvedValueOnce({ rows: [r('Maten', 'level', 'Senior')] });
    const out = await listEnrichmentFields('Principal');
    expect(out.map(f => f.column)).toEqual(['org.Maten.level']);
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual([['Principal', 'Identity'], VALUES_PER_FIELD]);
    expect(sql).toMatch(/jsonb_array_elements_text\(\s+CASE jsonb_typeof\(kv\.value\) WHEN 'array'/);
    expect(sql).toMatch(/WHERE rn <= \$2 ORDER BY source, key, rn/);
    expect(sql).not.toMatch(/ILIKE/);
  });

  it('only Resource enrichments for the resource picker; nothing for another entity', async () => {
    query.mockResolvedValue({ rows: [] });
    await listEnrichmentFields('Resource');
    expect(query.mock.calls[0][1][0]).toEqual(['Resource']);
    expect(await listEnrichmentFields('Context')).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('enrichmentFieldValues', () => {
  it('null for an ordinary column, without reading', async () => {
    expect(await enrichmentFieldValues('Principal', 'department', 'x')).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('searches one field\'s values, the term escaped and bound', async () => {
    query.mockResolvedValueOnce({ rows: [r('Maten', 'expertises', 'IAM_ops', true, 1)] });
    const out = await enrichmentFieldValues('Identity', 'org.Maten.expertises', '50%_');
    expect(out).toEqual({ column: 'org.Maten.expertises', values: ['IAM_ops'], truncated: false });
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual([['Identity', 'Principal'], 'Maten', 'expertises', '%50\\%\\_%', VALUES_PER_FIELD]);
    expect(sql).toMatch(/AND e\."entityType" = \$2/);
    expect(sql).toMatch(/WHERE k\.key = \$3/);
    expect(sql).toMatch(/AND ev\.v ILIKE \$4 ESCAPE '\\'/);
  });

  it('empty for a field nobody holds, a malformed field or an unknown entity', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await enrichmentFieldValues('Principal', 'org.Maten.none')).toEqual({ column: 'org.Maten.none', values: [], truncated: false });
    expect(await enrichmentFieldValues('Principal', 'org.Maten')).toEqual({ column: 'org.Maten', values: [], truncated: false });
    expect(await enrichmentFieldValues('Context', 'org.Maten.x')).toEqual({ column: 'org.Maten.x', values: [], truncated: false });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
