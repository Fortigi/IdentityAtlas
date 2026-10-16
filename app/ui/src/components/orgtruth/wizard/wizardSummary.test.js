// What step 7 shows: the summary rows per template and the completed-run line
// (activity runs read their key match counts).
import { describe, it, expect } from 'vitest';
import { confirmRows, runSummary } from './wizardSummary';

const SOURCE = { displayName: 'Contoso hours', rowCount: 40 };
const base = (recipe, extra = {}) => ({ source: SOURCE, runMode: 'full', recipe, linkRules: [], ...extra });
const tail = (rows) => rows.slice(2);

describe('confirmRows', () => {
  it('starts with the source, the mode and the kind', () => {
    const rows = confirmRows(base({ version: 1, entities: [], relations: [] }, { runMode: 'delta', source: null }));
    expect(rows.slice(0, 3)).toEqual([
      ['Source', '— (— rows)'], ['Mode', 'Delta: changes only what is in the list'], ['Kind', 'Collection'],
    ]);
    expect(confirmRows(base({ version: 1, entities: [], relations: [] }))[1]).toEqual(['Mode', 'Full: closes what the list no longer contains']);
  });

  it('collection: entities, relations, link rules (or none)', () => {
    const recipe = { entities: [{ type: 'Project' }, { type: 'Owner' }], relations: [{ from: 'Project', predicate: 'owner', to: 'Owner' }] };
    const rule = { entityType: 'Owner', targetType: 'Principal', via: 'email', signals: [{}, {}] };
    expect(tail(confirmRows(base(recipe, { linkRules: [rule] })))).toEqual([
      ['Kind', 'Collection'], ['Entities', 'Project, Owner'], ['Relations', 'Project owner Owner'], ['Link rules', 'Owner: email → Principal (2 signals)'],
    ]);
    expect(tail(confirmRows(base({ entities: [], relations: [] })))).toEqual([['Kind', 'Collection'], ['Entities', '—'], ['Relations', '—'], ['Link rules', 'none']]);
  });

  it('enrichment: target, key column, attributes with their multi hint', () => {
    const recipe = { template: 'enrichment', entities: [{ type: 'Expertise', nameColumn: 'Email', attributes: [{ column: 'Skills', name: 'expertises', multi: true }, { column: 'Level', name: '' }] }], relations: [], enrich: { targetType: 'Principal' } };
    expect(tail(confirmRows(base(recipe)))).toEqual([
      ['Kind', 'Enrichment'], ['Adds to', 'Principal by Email (Expertise)'], ['Attributes', 'expertises (multiple values), Level'], ['Link rules', 'none'],
    ]);
  });

  it('activity: what, when and the measure', () => {
    const activity = {
      type: 'Hours', actor: { column: 'Employee' }, subject: { column: 'Customer', targetType: 'OrgEntity', targetEntityType: 'Client' },
      when: { yearColumn: 'Year', monthColumn: 'Month' }, measure: { column: 'Hours', unit: 'h' },
    };
    expect(tail(confirmRows(base({ template: 'activity', entities: [], relations: [], activity })))).toEqual([
      ['Kind', 'Activity'], ['Activity', 'Hours: Employee on Customer (Client)'], ['When', 'year in Year, month in Month'], ['Measure', 'Hours (h)'],
    ]);
    const plain = { ...activity, subject: { column: 'Group', targetType: 'Resource' }, when: { dateColumn: 'Date' }, measure: { column: 'Hours', unit: '' } };
    expect(tail(confirmRows(base({ template: 'activity', entities: [], relations: [], activity: plain }))).slice(1)).toEqual([
      ['Activity', 'Hours: Employee on Group (Resource)'], ['When', 'date in Date'], ['Measure', 'Hours'],
    ]);
    expect(confirmRows(base({ template: 'activity', entities: [], relations: [], activity: { ...plain, measure: { column: '' } } })).at(-1)).toEqual(['Measure', 'none']);
  });

  it('relation: both ends and the predicate', () => {
    const relation = { type: 'Incompatibility', predicate: 'incompatibleWith', left: { column: 'A', targetType: 'Resource' }, right: { column: 'B', targetType: 'OrgEntity', targetEntityType: 'Application' } };
    expect(tail(confirmRows(base({ template: 'relation', entities: [], relations: [], relation })))).toEqual([
      ['Kind', 'Relation'], ['Relation', 'Incompatibility: A (Resource) incompatibleWith B (Application)'],
    ]);
  });
});

describe('runSummary', () => {
  it('reads a collection run as before', () => {
    expect(runSummary({ rows: 3, entities: { byType: { Project: 3, Owner: 2 } }, links: { linked: 2, proposed: 0, none: 1 } }))
      .toBe('Import completed: 3 rows; 3 Project, 2 Owner; 2 linked, 0 proposed for review, 1 without a match.');
    expect(runSummary({ rows: 1 })).toBe('Import completed: 1 rows.');
    expect(runSummary({ rows: 2, links: { linked: 0 } })).toBe('Import completed: 2 rows; 0 linked, 0 proposed for review, 0 without a match.');
    expect(runSummary()).toBe('Import completed: 0 rows.');
  });

  it('reads an activity run: activities, both key counts, skipped rows', () => {
    const stats = {
      rows: 1152, activities: 1150, skipped: 2,
      keys: { actor: { total: 31, accepted: 28, proposed: 2, unmatched: 1 }, subject: { total: 14, accepted: 14, proposed: 0, unmatched: 0 } },
    };
    expect(runSummary(stats)).toBe('Import completed: 1152 rows; 1150 activities; 31 actor values: 28 matched, 2 proposed, 1 without a match; '
      + '14 subject values: 14 matched, 0 proposed, 0 without a match; 2 rows skipped.');
    expect(runSummary({ rows: 5, keys: { subject: { total: 1, accepted: 1 } }, skipped: 0 }))
      .toBe('Import completed: 5 rows; 0 activities; 1 subject value: 1 matched, 0 proposed, 0 without a match.');
  });
});
