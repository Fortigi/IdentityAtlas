import { describe, it, expect } from 'vitest';
import { normalizeRecipe } from '../contracts.js';
import { applyTemplate } from './templateRecipe.js';
import { summarizeApplied } from './applyRecipe.js';

const relation = normalizeRecipe({
  version: 1, template: 'relation',
  relation: {
    type: 'SoD', predicate: 'incompatibleWith',
    left: { column: 'A', targetType: 'Resource' }, right: { column: 'B', targetType: 'Resource' }, attributes: [{ column: 'Why', name: 'reason' }],
  },
});

describe('applyTemplate — relation', () => {
  const rows = [
    { A: 'SG_Pay_Approve', B: 'SG_Pay_Create', Why: 'Four eyes' },
    { A: 'SG_Pay_Approve', B: 'SG_Vendor_Edit', Why: '' },
    { A: 'SG_Pay_Create', B: '', Why: 'half' },
    { A: '', B: '', Why: '' },
    { A: 'SG_Pay_Approve', B: 'SG_Pay_Create', Why: 'again' },
  ];
  const { recipe, applied } = applyTemplate(rows, relation);

  it('one entity per pair: named "left → right", keyed on both ends, the ends kept as left/right', () => {
    expect(applied.entities.map(e => [e.displayName, e.canonicalKey, e.attributes])).toEqual([
      ['SG_Pay_Approve → SG_Pay_Create', 'sg_pay_approve | sg_pay_create', { left: 'SG_Pay_Approve', right: 'SG_Pay_Create', reason: 'Four eyes' }],
      ['SG_Pay_Approve → SG_Vendor_Edit', 'sg_pay_approve | sg_vendor_edit', { left: 'SG_Pay_Approve', right: 'SG_Vendor_Edit' }],
    ]);
    expect(applied.entities.every(e => e.entityType === 'SoD')).toBe(true);
    expect(applied.relations).toEqual([]);
  });

  it('a row with one end is a missingSide issue; a blank row is nothing; a repeated pair is the collection\'s duplicateKey', () => {
    expect(applied.issues.map(i => [i.kind, i.row])).toEqual([['missingSide', 3], ['duplicateKey', 5]]);
    expect(applied.issues[0].detail).toBe('Row 3 has no B, so it is not a pair and is left out.');
    const left = applyTemplate([{ A: '', B: 'X', Why: '' }], relation).applied.issues[0];
    expect(left.detail).toBe('Row 1 has no A, so it is not a pair and is left out.');
  });

  it('returns the collection-shaped recipe the summary reads', () => {
    expect(summarizeApplied(applied, recipe)).toEqual({ entities: { SoD: { total: 2, duplicateKeys: 1, emptyKeys: 0 } }, relations: {} });
  });

  it('does not change the caller\'s rows', () => {
    expect(Object.keys(rows[0])).toEqual(['A', 'B', 'Why']);
  });
});

describe('applyTemplate — collection and enrichment', () => {
  it('are applied as they are, multi-valued attributes as lists', () => {
    const enrichment = normalizeRecipe({
      version: 1, template: 'enrichment', enrich: { targetType: 'Identity' },
      entities: [{ type: 'Staff', nameColumn: 'Name', attributes: [{ column: 'Skills', name: 'skills', multi: true }, { column: 'Role', name: 'role' }] }],
    });
    const { recipe, applied } = applyTemplate([{ Name: 'Ann Example', Skills: 'IAM, Azure;IAM', Role: 'Lead, Senior' }], enrichment);
    expect(recipe).toBe(enrichment);
    expect(applied.entities[0].attributes).toEqual({ skills: ['IAM', 'Azure'], role: 'Lead, Senior' });
  });
});
